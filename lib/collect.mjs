// Reads what happened in a time window from Claude Code and Codex session logs
// and from the git repos those sessions touched, and turns it into one digest.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOME = os.homedir();

export const SOURCES = {
  claude: path.join(HOME, '.claude', 'projects'),
  codex: path.join(HOME, '.codex', 'sessions'),
  codexArchived: path.join(HOME, '.codex', 'archived_sessions'),
  codexIndex: path.join(HOME, '.codex', 'session_index.jsonl'),
  claudeDesktop: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
};

// A session written to in the last few minutes is treated as still working.
const ACTIVE_MS = 10 * 60 * 1000;
// How much of each session goes into the log, from roomy to tight. The tightest
// level that still fits a size limit is used (local models have small contexts).
const LEVELS = [
  { prompt: 600, final: 1400, finals: 3, prompts: 24, commits: 80 },
  { prompt: 400, final: 900, finals: 2, prompts: 14, commits: 40 },
  { prompt: 280, final: 600, finals: 1, prompts: 10, commits: 20 },
  { prompt: 200, final: 360, finals: 1, prompts: 6, commits: 10 },
  { prompt: 140, final: 220, finals: 1, prompts: 3, commits: 5 },
];

export const RANGES = ['3h', '6h', '12h', 'today', '24h'];

export function windowFor(range = '6h', now = new Date()) {
  const r = String(range).trim().toLowerCase();
  if (r === 'today') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { range: r, from, to: now };
  }
  const m = r.match(/^(\d+(?:\.\d+)?)\s*([hd])$/);
  if (!m) throw new Error(`Unknown range "${range}". Use 3h, 6h, 12h, 24h, 2d or today.`);
  const ms = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
  return { range: r, from: new Date(now.getTime() - ms), to: now };
}

export function hm(d, now = new Date()) {
  const date = new Date(d);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

const tilde = (p) => (p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => {
  const t = squash(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

async function* lines(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}

async function recentFiles(dirs, from) {
  const out = [];
  for (const dir of dirs) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (st.isFile() && st.mtimeMs >= from.getTime()) out.push({ file, mtime: st.mtimeMs });
      } catch {
        /* removed while listing */
      }
    }
  }
  return out;
}

function newSession(source, file, mtime) {
  return {
    source,
    id: path.basename(file, '.jsonl'),
    file,
    mtime,
    title: null,
    cwd: null,
    origin: null,
    earlier: null,
    prompts: [],
    finals: [],
    latest: null,
    edits: new Set(),
    dirs: new Set(),
    first: null,
    last: null,
  };
}

function touch(s, t) {
  if (!s.first || t < s.first) s.first = t;
  if (!s.last || t > s.last) s.last = t;
}

// ---------- Claude Code ----------

function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

function cleanClaudePrompt(raw) {
  let s = String(raw || '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    s = `${cmd[1].trim()} ${args.trim()}`;
  }
  s = s.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g, (_, body) => `[pasted: ${clip(body, 240)}]`);
  s = s.trim();
  if (!s) return null;
  if (/^(Caveat:|\[Request interrupted|This session is being continued|The app was quit while you were working)/.test(s)) return null;
  if (/^<[a-z][\w-]*[\s>]/i.test(s)) return null; // harness wrappers: task notifications, command output, events
  return s;
}

async function readClaude({ file, mtime }, from) {
  const s = newSession('claude', file, mtime);
  const titles = {};
  let turnText = null;
  for await (const line of lines(file)) {
    if (line.includes('"type":"custom-title"') || line.includes('"type":"ai-title"') || line.includes('"type":"summary"')) {
      const d = parse(line);
      if (d?.customTitle) titles.custom = d.customTitle;
      if (d?.aiTitle) titles.ai = d.aiTitle;
      if (d?.type === 'summary' && d.summary) titles.summary = d.summary;
      continue;
    }
    const isUser = line.includes('"type":"user"');
    const isAssistant = !isUser && line.includes('"type":"assistant"');
    if (!isUser && !isAssistant) continue;
    if (isUser && line.includes('"type":"tool_result"')) continue;
    const d = parse(line);
    if (!d || d.isSidechain || !d.timestamp) continue;
    const t = new Date(d.timestamp);
    if (d.cwd) s.cwd = d.cwd;

    if (d.type === 'user') {
      if (d.isMeta || d.isCompactSummary) continue;
      const text = cleanClaudePrompt(claudeText(d.message?.content));
      if (!text) continue;
      if (t < from) {
        s.earlier = { t, text };
        continue;
      }
      if (turnText) s.finals.push(turnText);
      turnText = null;
      s.prompts.push({ t, text });
      touch(s, t);
    } else if (d.type === 'assistant') {
      if (t < from) continue;
      touch(s, t);
      if (d.cwd) s.dirs.add(d.cwd);
      for (const b of d.message?.content || []) {
        if (b?.type === 'text' && (b.text || '').trim().length > 40) {
          turnText = { t, text: b.text.trim() };
          s.latest = turnText;
        } else if (b?.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) {
          const fp = b.input?.file_path || b.input?.notebook_path;
          if (fp) s.edits.add(fp);
        }
      }
    }
  }
  if (turnText) s.finals.push(turnText);
  s.title = titles.custom || titles.ai || titles.summary || null;
  return s;
}

// The Claude desktop app keeps one small file per Code session: its own id (for
// claude:// links), its title, and whether the session is waiting on the person.
async function claudeDesktopIndex(from) {
  const index = new Map();
  const since = from.getTime() - 3_600_000;
  const walk = async (dir, depth) => {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (depth < 2) await walk(full, depth + 1);
      else if (/^local_[\w-]+\.json$/.test(name)) {
        try {
          if ((await fsp.stat(full)).mtimeMs < since) continue;
          const d = JSON.parse(await fsp.readFile(full, 'utf8'));
          if (!d.cliSessionId) continue;
          index.set(d.cliSessionId, {
            id: d.sessionId,
            title: d.title || null,
            status: d.postTurnSummary?.status_category || null,
            needs: d.postTurnSummary?.needs_action || null,
          });
        } catch {
          /* written while reading */
        }
      }
    }
  };
  await walk(SOURCES.claudeDesktop, 0);
  return index;
}

// ---------- Codex ----------

async function codexTitles() {
  const map = new Map();
  try {
    for await (const line of lines(SOURCES.codexIndex)) {
      const d = parse(line);
      if (d?.id && d.thread_name) map.set(d.id, d.thread_name);
    }
  } catch {
    /* no index yet */
  }
  return map;
}

function cleanCodexPrompt(raw) {
  let s = String(raw || '');
  const beat = s.match(/<heartbeat>[\s\S]*?<automation_id>([^<]+)<\/automation_id>/);
  if (beat) return `[scheduled automation ran: ${beat[1].trim()}]`;
  const reply = s.match(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/);
  if (reply) {
    try {
      const items = JSON.parse(reply[1].trim());
      return items.map((x) => `[answered the agent's question "${clip(x.question, 140)}": ${x.answer}]`).join(' ');
    } catch {
      return null;
    }
  }
  s = s.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, '');
  const ask = s.indexOf('## My request:');
  if (ask >= 0) s = s.slice(ask + '## My request:'.length);
  s = s.replace(/<(recommended_plugins|external_codex_apps_open_page|environment_context|user_instructions|turn_aborted|skill)\b[\s\S]*?<\/\1>/g, '');
  s = s.trim();
  if (!s || s.startsWith('# AGENTS.md') || s.startsWith('# Files mentioned') || /^<[a-z][\w-]*[\s>]/i.test(s)) return null;
  return s;
}

async function readCodex({ file, mtime }, from, titles) {
  const s = newSession('codex', file, mtime);
  const fallback = [];
  let sawItems = false;
  for await (const line of lines(file)) {
    if (line.includes('"type":"session_meta"')) {
      const p = parse(line)?.payload || {};
      if (p.id) s.id = p.id;
      s.cwd = p.cwd || s.cwd;
      s.origin = p.originator || null;
      continue;
    }
    const isItem = line.includes('"item_completed"');
    const wanted =
      (isItem && (line.includes('"type":"UserMessage"') || line.includes('"type":"AgentMessage"') || line.includes('"type":"FileChange"'))) ||
      line.includes('"task_complete"') ||
      (line.includes('"response_item"') && line.includes('"role":"user"'));
    if (!wanted) continue;
    const d = parse(line);
    if (!d?.timestamp) continue;
    const t = new Date(d.timestamp);
    const p = d.payload || {};

    if (d.type === 'event_msg' && p.type === 'item_completed') {
      const it = p.item || {};
      const text = (it.content || []).map((c) => c?.text || '').join('\n');
      if (it.type === 'UserMessage') {
        sawItems = true;
        const clean = cleanCodexPrompt(text);
        if (!clean) continue;
        if (t < from) s.earlier = { t, text: clean };
        else {
          s.prompts.push({ t, text: clean });
          touch(s, t);
        }
      } else if (it.type === 'AgentMessage' && t >= from && text.trim().length > 40) {
        s.latest = { t, text: text.trim() };
        touch(s, t);
      } else if (it.type === 'FileChange' && t >= from) {
        for (const fp of Object.keys(it.changes || {})) s.edits.add(fp);
      }
    } else if (d.type === 'event_msg' && p.type === 'task_complete') {
      if (t >= from && p.last_agent_message) {
        s.finals.push({ t, text: String(p.last_agent_message).trim() });
        touch(s, t);
      }
    } else if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = (p.content || []).map((c) => c?.text || '').join('\n');
      const clean = cleanCodexPrompt(text);
      if (clean) fallback.push({ t, text: clean });
    }
  }
  if (!sawItems) {
    // Older sessions and `codex exec` jobs only record the raw model input.
    for (const x of fallback) {
      if (x.t < from) s.earlier = x;
      else {
        s.prompts.push(x);
        touch(s, x.t);
      }
    }
  }
  s.title = titles.get(s.id) || null;
  return s;
}

// ---------- git ----------

async function git(args, cwd) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function reposFor(dirs) {
  const tops = new Map();
  const known = [];
  for (const raw of [...dirs].sort()) {
    let dir = raw;
    while (dir && dir !== '/' && !fs.existsSync(dir)) dir = path.dirname(dir);
    if (!dir || dir === '/' || dir === HOME) continue;
    if (known.some((top) => dir === top || dir.startsWith(`${top}/`))) continue;
    try {
      const [top, common] = (await git(['rev-parse', '--show-toplevel', '--git-common-dir'], dir)).trim().split('\n');
      if (!top || top === HOME) continue;
      known.push(top);
      const key = path.resolve(top, common);
      if (!tops.has(key)) tops.set(key, top);
    } catch {
      /* not a repo */
    }
  }
  return [...tops.values()];
}

async function commitsIn(top, from) {
  const repo = { path: top, commits: [], branch: null, dirty: 0 };
  try {
    const out = await git(['log', '--branches', `--since=${from.toISOString()}`, '--no-merges', '-n', '80', '--format=%h%x09%ct%x09%s'], top);
    for (const row of out.split('\n').filter(Boolean)) {
      const [hash, ct, ...subject] = row.split('\t');
      repo.commits.push({ hash, t: new Date(Number(ct) * 1000), subject: subject.join('\t') });
    }
    repo.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], top)).trim();
    repo.dirty = (await git(['status', '--porcelain'], top)).split('\n').filter(Boolean).length;
  } catch {
    /* repo vanished or locked */
  }
  return repo;
}

// ---------- collect ----------

export async function collect({ range = '6h', now = new Date(), onProgress = () => {} } = {}) {
  const win = windowFor(range, now);
  const { from } = win;

  onProgress('Reading sessions');
  let claudeDirs = [];
  try {
    // Some project folders are symlinks to others; read each real folder once.
    const real = await Promise.all(
      (await fsp.readdir(SOURCES.claude)).map((d) => fsp.realpath(path.join(SOURCES.claude, d)).catch(() => null)),
    );
    claudeDirs = [...new Set(real.filter(Boolean))];
  } catch {
    /* no Claude Code history */
  }
  const codexDirs = [SOURCES.codexArchived];
  for (let day = new Date(from.getTime() - 30 * 86_400_000); day <= now; day = new Date(day.getTime() + 86_400_000)) {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, '0');
    const dd = String(day.getDate()).padStart(2, '0');
    codexDirs.push(path.join(SOURCES.codex, String(y), m, dd));
  }

  const [claudeFiles, codexFiles, titles, desktop] = await Promise.all([
    recentFiles(claudeDirs, from),
    recentFiles(codexDirs, from),
    codexTitles(),
    claudeDesktopIndex(from),
  ]);
  const seen = new Set();
  const sessions = (
    await Promise.all([...claudeFiles.map((f) => readClaude(f, from)), ...codexFiles.map((f) => readCodex(f, from, titles))])
  ).filter((s) => {
    const key = `${s.source}:${s.id}`;
    if (seen.has(key) || !(s.prompts.length || s.finals.length || s.latest)) return false;
    seen.add(key);
    return true;
  });

  for (const s of sessions) {
    s.active = now.getTime() - s.mtime < ACTIVE_MS;
    if (s.source === 'claude' && desktop.has(s.id)) {
      s.desktop = desktop.get(s.id);
      s.title = s.desktop.title || s.title;
    }
    s.link = linkFor(s);
    if (s.cwd) s.dirs.add(s.cwd);
    for (const fp of s.edits) s.dirs.add(path.dirname(fp));
  }
  sessions.sort((a, b) => (a.first || a.mtime) - (b.first || b.mtime));

  onProgress('Reading commits');
  const dirs = new Set(sessions.flatMap((s) => [...s.dirs]));
  const repos = (await Promise.all((await reposFor(dirs)).map((top) => commitsIn(top, from)))).filter(
    (r) => r.commits.length || r.dirty,
  );

  const stats = {
    claude: sessions.filter((s) => s.source === 'claude').length,
    codex: sessions.filter((s) => s.source === 'codex').length,
    sessions: sessions.length,
    commits: repos.reduce((n, r) => n + r.commits.length, 0),
    repos: repos.filter((r) => r.commits.length).length,
  };
  return { window: win, now, sessions, repos, stats };
}

// ---------- links ----------

// Where a click on the session's icon goes: the chat itself in the app that ran it.
function linkFor(s) {
  if (s.source === 'claude' && s.desktop?.id) return `claude://code/continue?session=${encodeURIComponent(s.desktop.id)}`;
  if (s.source === 'codex' && s.origin === 'Codex Desktop') return `codex://threads/${encodeURIComponent(s.id)}`;
  return null;
}

// The sessions as the summary refers to them: number n is "## n." in the digest.
export function sessionRefs(data) {
  return data.sessions.map((s, i) => ({
    n: i + 1,
    app: s.source,
    title: s.title || null,
    link: s.link,
    helper: s.source === 'codex' && s.origin === 'codex_exec',
    active: s.active,
    last: new Date(s.last || s.mtime).toISOString(),
  }));
}

// ---------- digest ----------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text) {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

function sessionLabel(s) {
  if (s.source === 'claude') return 'Claude Code';
  if (s.origin === 'codex_exec') return 'Codex (helper job run by another agent)';
  return 'Codex';
}

export function digest(data, { maxChars = Infinity } = {}) {
  let text = '';
  for (const level of LEVELS) {
    text = digestAt(data, level);
    if (text.length <= maxChars) return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n… (log cut to fit the model's context)`;
}

function digestAt(data, L) {
  const { window: win, now, sessions, repos } = data;
  const out = [];
  out.push(`Window: ${hm(win.from, now)} to ${hm(now, now)} (local time). Now: ${hm(now, now)}.`);
  out.push(`Sessions: ${sessions.length}. Commits: ${data.stats.commits}.`);

  sessions.forEach((s, i) => {
    const span = s.first ? `${hm(s.first, now)}–${s.active ? 'now' : hm(s.last, now)}` : '';
    out.push('');
    out.push(
      `## ${i + 1}. ${sessionLabel(s)} · "${s.title || 'untitled'}" · ${tilde(s.cwd) || ''} · ${span}${s.active ? ' · ACTIVE (written to in the last 10 minutes)' : ''}`,
    );
    if (s.earlier && s.prompts.length === 0) out.push(`Continuing from an earlier ask [${hm(s.earlier.t, now)}]: ${clip(s.earlier.text, L.prompt)}`);
    if (s.prompts.length) {
      out.push('They asked:');
      const head = Math.min(4, Math.ceil(L.prompts / 4));
      const tail = L.prompts - head;
      const shown = s.prompts.length > L.prompts ? [...s.prompts.slice(0, head), null, ...s.prompts.slice(-tail)] : s.prompts;
      for (const p of shown) {
        if (!p) out.push(`- (${s.prompts.length - L.prompts} more asks)`);
        else out.push(`- [${hm(p.t, now)}] ${clip(p.text, L.prompt)}`);
      }
    }
    const finals = s.finals.slice(-L.finals);
    if (finals.length) {
      out.push('The agent reported back:');
      for (const f of finals) out.push(`- [${hm(f.t, now)}] ${clip(f.text, L.final)}`);
    }
    if (s.latest && !finals.some((f) => f.text === s.latest.text)) {
      out.push(`Latest progress note [${hm(s.latest.t, now)}]: ${clip(s.latest.text, L.prompt)}`);
    }
    if (s.edits.size) {
      const files = [...s.edits].slice(-6).map((f) => tilde(f));
      out.push(`Files edited: ${s.edits.size} (e.g. ${files.join(', ')})`);
    }
    if (s.desktop?.status === 'blocked' && s.desktop.needs) out.push(`The Claude app marks this session as waiting on the person: ${clip(s.desktop.needs, 300)}`);
    else if (s.desktop?.status) out.push(`The Claude app marks this session as: ${s.desktop.status.replace(/_/g, ' ')}`);
  });

  if (repos.length) {
    out.push('');
    out.push('## Git');
    for (const r of repos) {
      out.push(`### ${tilde(r.path)} (checked out: ${r.branch || '?'}; uncommitted files now: ${r.dirty})`);
      for (const c of r.commits.slice(0, L.commits)) out.push(`- ${hm(c.t, now)} ${c.hash} ${clip(c.subject, 160)}`);
      if (r.commits.length > L.commits) out.push(`- (${r.commits.length - L.commits} more commits)`);
      if (!r.commits.length) out.push('- no commits in the window');
    }
  }
  return redact(out.join('\n'));
}
