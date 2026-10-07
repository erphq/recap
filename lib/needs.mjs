// Chats that are waiting on the person right now, read from the apps' own
// records rather than a model: the Claude desktop app marks a Code session as
// blocked with what it needs, and Codex logs a question until it is answered.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SOURCES } from './collect.mjs';

const CODEX_DAYS = 3;
const QUESTION_CALL = 'request_user_input_async';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export class NeedsWatcher {
  constructor() {
    this.claude = new Map(); // file -> { mtimeMs, need | null }
    this.codex = new Map(); // file -> { offset, rest, id, origin, questions: Map(callId -> question) }
    this.titles = new Map();
    this.titlesMtime = 0;
  }

  // Everything waiting now, newest first.
  async scan() {
    await Promise.all([this.scanClaude(), this.scanCodex()]);
    const out = new Map(); // the Claude app can keep the same session under two folders
    for (const { need } of this.claude.values()) if (need) out.set(need.key, need);
    for (const s of this.codex.values()) {
      if (s.origin === 'codex_exec') continue;
      for (const [callId, q] of s.questions) {
        out.set(`codex:${callId}`, {
          key: `codex:${callId}`,
          app: 'codex',
          title: this.titles.get(s.id) || 'Codex',
          text: q.text,
          link: s.id ? `codex://threads/${encodeURIComponent(s.id)}` : null,
          at: q.at,
        });
      }
    }
    return [...out.values()].sort((a, b) => b.at - a.at);
  }

  async scanClaude() {
    const files = [];
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
        else if (/^local_[\w-]+\.json$/.test(name)) files.push(full);
      }
    };
    await walk(SOURCES.claudeDesktop, 0);
    const since = Date.now() - 7 * 86_400_000;
    for (const file of files) {
      try {
        const { mtimeMs } = await fsp.stat(file);
        if (mtimeMs < since) {
          this.claude.delete(file);
          continue;
        }
        if (this.claude.get(file)?.mtimeMs === mtimeMs) continue;
        const d = JSON.parse(await fsp.readFile(file, 'utf8'));
        const p = d.postTurnSummary || {};
        const blocked = p.status_category === 'blocked' && !d.isArchived;
        this.claude.set(file, {
          mtimeMs,
          need: blocked
            ? {
                key: `claude:${d.sessionId}:${d.lastActivityAt || mtimeMs}`,
                app: 'claude',
                title: d.title || 'Claude',
                text: clip(p.needs_action || p.status_detail || 'Waiting for you', 240),
                link: `claude://code/continue?session=${encodeURIComponent(d.sessionId)}`,
                at: d.lastActivityAt || mtimeMs,
              }
            : null,
        });
      } catch {
        /* being written; next pass */
      }
    }
  }

  async loadTitles() {
    try {
      const { mtimeMs } = await fsp.stat(SOURCES.codexIndex);
      if (mtimeMs === this.titlesMtime) return;
      this.titlesMtime = mtimeMs;
      for (const line of (await fsp.readFile(SOURCES.codexIndex, 'utf8')).split('\n')) {
        try {
          const d = JSON.parse(line);
          if (d.id && d.thread_name) this.titles.set(d.id, d.thread_name);
        } catch {
          /* partial line */
        }
      }
    } catch {
      /* no index */
    }
  }

  async scanCodex() {
    await this.loadTitles();
    const now = new Date();
    for (let i = 0; i < CODEX_DAYS; i++) {
      const day = new Date(now.getTime() - i * 86_400_000);
      const dir = path.join(SOURCES.codex, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) if (name.endsWith('.jsonl')) await this.readCodexTail(path.join(dir, name));
    }
  }

  // Reads only what was appended since the last pass.
  async readCodexTail(file) {
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      return;
    }
    let s = this.codex.get(file);
    if (!s) {
      s = { offset: 0, rest: '', id: null, origin: null, questions: new Map() };
      this.codex.set(file, s);
    }
    if (size <= s.offset) return;
    const fd = await fsp.open(file, 'r');
    try {
      const length = size - s.offset;
      const buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, s.offset);
      s.offset = size;
      const lines = (s.rest + buf.toString('utf8')).split('\n');
      s.rest = lines.pop();
      for (const line of lines) this.codexLine(s, line);
    } finally {
      await fd.close();
    }
  }

  codexLine(s, line) {
    if (line.includes('"type":"session_meta"')) {
      try {
        const p = JSON.parse(line).payload || {};
        s.id = p.id || s.id;
        s.origin = p.originator || s.origin;
      } catch {
        /* skip */
      }
      return;
    }
    if (!line.includes(QUESTION_CALL)) return;
    // An answer names the question's call id; it arrives as the person's next message.
    if (line.includes('send_user_message_question_reply')) {
      for (const [callId] of s.questions) if (line.includes(callId)) s.questions.delete(callId);
      return;
    }
    if (!line.includes('"type":"function_call"')) return;
    try {
      const d = JSON.parse(line);
      const p = d.payload || {};
      if (p.type !== 'function_call' || p.name !== QUESTION_CALL || !p.call_id) return;
      const args = JSON.parse(p.arguments || '{}');
      const text = (args.questions || []).map((q) => q.title || q.question).filter(Boolean).join(' ');
      s.questions.set(p.call_id, { text: clip(text || 'Codex has a question for you', 240), at: new Date(d.timestamp).getTime() });
    } catch {
      /* skip */
    }
  }
}

export async function waitingNow() {
  return new NeedsWatcher().scan();
}
