// Turns the collected log into one-liners. Four ways to write them:
//   openrouter  your OpenRouter account (any model with structured output)
//   local       any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM
//   codex       the Codex CLI on this machine (`codex exec --ephemeral`)
//   claude      the Claude Code CLI on this machine (`claude -p`)
// "auto" tries the ones that are set up, in that order. A specific choice never
// falls back, so a local-only setup never sends the log anywhere else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { CACHE, ROOT } from './paths.mjs';
import { readSettings, secret } from './settings.mjs';

export { ROOT };
const HOME = os.homedir();
const WORK = path.join(CACHE, 'work');
const CLI_TIMEOUT_MS = 4 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000;
export const LABEL = { openrouter: 'OpenRouter', local: 'Local model', codex: 'Codex', claude: 'Claude Code' };

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['needsYou', 'items'],
  properties: {
    needsYou: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sessions'],
        properties: {
          text: { type: 'string' },
          sessions: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tag', 'line', 'status', 'sessions'],
        properties: {
          tag: { type: 'string' },
          line: { type: 'string' },
          status: { type: 'string', enum: ['done', 'running', 'waiting'] },
          sessions: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
};

export const INSTRUCTIONS = `You write a recap of what one person got done with their AI agents in a time window. The log below lists their Claude Code and Codex sessions (what they asked, what the agent reported back) and their git commits.

Write one-liners they can take in at a glance. Rules:
- One item per piece of work. Merge sessions and steps about the same work, including helper jobs that served it (a site's launch, its artwork and its logo can be one or two items). Never drop a distinct piece of work to save space; merge instead. Skip pure lookups and requests for a recap like this one, unless they produced something.
- line: at most 10 words, ideally 6 to 8. Plain words, outcome first. Past tense for finished work ("Launched the docs site on Vercel with 14 guides"); for ongoing work say what is happening and where it stands ("Benchmarking search: 56% vs 76% recall so far"). Concrete names and numbers beat descriptions. No file paths, ids, hedges, or filler such as "worked on".
- tag: what the work is about, in one or two words, spelled the same way every time and the way the person spells it (for example Billing, Docs site, Mobile app). Judge it from the content, not the folder: many sessions run in one folder but are about other projects.
- status: "running" if the session is marked ACTIVE and the agent was still working; "waiting" if the agent finished and is waiting on the person's decision or input; otherwise "done".
- needsYou: up to 5 decisions or inputs an agent asked for that the person has not given yet; leave out anything a later message shows they already did. Sessions the Claude app marks as waiting on the person are the strongest signal. Each text is an imperative under 10 words ("Pick a logo from the nine options"). Empty when there are none.
- sessions: for every item and every needsYou entry, the numbers of the sessions it comes from (the N in "## N."), so the person can jump to those chats. When helper jobs did the work, also list the session that started them.
- Order items by tag, the tag with the most work first; within a tag, the most significant first. At most 12 items.
- Use only what the log says; never invent an outcome. Do not run commands or open files: everything you need is below.`;

const JSON_ONLY = `\n\nReply with only a JSON object, no other text, matching this JSON Schema:\n${JSON.stringify(SCHEMA)}`;

// ---------- result handling ----------

function parseJson(text) {
  const t = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning models served locally
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

// Small local models drift from the schema; keep what is usable.
function normalize(raw) {
  const obj = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!obj || !Array.isArray(obj.items)) throw new Error('The summary came back in the wrong shape');
  const ints = (a) => (Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : []);
  const items = obj.items
    .filter((it) => it && typeof it.line === 'string' && it.line.trim())
    .map((it) => ({
      tag: String(it.tag || 'Other').trim(),
      line: it.line.trim(),
      status: ['done', 'running', 'waiting'].includes(it.status) ? it.status : 'done',
      sessions: ints(it.sessions),
    }));
  const needsYou = (Array.isArray(obj.needsYou) ? obj.needsYou : [])
    .map((n) => (typeof n === 'string' ? { text: n.trim(), sessions: [] } : { text: String(n?.text || '').trim(), sessions: ints(n?.sessions) }))
    .filter((n) => n.text);
  return { needsYou, items };
}

// ---------- OpenAI-compatible chat (OpenRouter and local servers) ----------

// Asks for strict JSON Schema output first; servers that don't support it get
// plain JSON mode, then no response format at all.
async function viaChat({ url, key, model, headers = {}, extra = {}, log, timeoutMs, name }) {
  const formats = [
    { response_format: { type: 'json_schema', json_schema: { name: 'recap', strict: true, schema: SCHEMA } } },
    { response_format: { type: 'json_object' }, hint: true },
    { hint: true },
  ];
  let lastError = null;
  for (const f of formats) {
    const body = {
      model,
      messages: [
        { role: 'system', content: f.hint ? INSTRUCTIONS + JSON_ONLY : INSTRUCTIONS },
        { role: 'user', content: `----- LOG -----\n${log}` },
      ],
      ...(f.response_format ? { response_format: f.response_format } : {}),
      ...extra,
    };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? `${name} took too long` : `Couldn't reach ${url} (${err.cause?.code || err.message})`);
    }
    const json = await res.json().catch(() => null);
    const message = json?.error?.message || json?.error || json?.detail;
    if (res.ok && !json?.error) {
      try {
        return normalize(json?.choices?.[0]?.message?.content);
      } catch (err) {
        lastError = err;
        continue; // try a looser format
      }
    }
    lastError = new Error(typeof message === 'string' ? message : `${name} answered ${res.status}`);
    if (res.status !== 400 && res.status !== 422) break; // auth, missing model, server down: retrying won't help
  }
  throw lastError;
}

const chatUrl = (base) => `${String(base).replace(/\/+$/, '')}/chat/completions`;

// ---------- CLIs ----------

let toolPath = null;

// Apps opened from the Dock start with a bare PATH, so borrow the login shell's once.
function envWithTools() {
  if (!toolPath) {
    const parts = (process.env.PATH || '').split(':');
    const shell = process.env.SHELL || '/bin/zsh';
    try {
      const out = execFileSync(shell, ['-ilc', 'printf "__RECAP_PATH__%s" "$PATH"'], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      parts.push(...(out.split('__RECAP_PATH__').pop() || '').split(':'));
    } catch {
      /* fall back to the usual install folders */
    }
    parts.push(path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.bun/bin'));
    toolPath = [...new Set(parts.filter(Boolean))].join(':');
  }
  const env = { ...process.env, PATH: toolPath };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const lastLine = (s) =>
  String(s)
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .pop() || '';

function runCli(bin, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: WORK, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${bin} took longer than ${CLI_TIMEOUT_MS / 60000} minutes`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${bin} is not installed`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(lastLine(stderr) || lastLine(stdout) || `${bin} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function viaCodex(log, model) {
  const schemaFile = path.join(WORK, 'schema.json');
  const outFile = path.join(WORK, `last-${process.pid}.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never'];
  args.push('-c', `model_reasoning_effort="${process.env.RECAP_EFFORT || 'low'}"`);
  args.push('--output-schema', schemaFile, '-o', outFile);
  if (model) args.push('-m', model);
  args.push('-');
  try {
    await runCli('codex', args, `${INSTRUCTIONS}\n\n----- LOG -----\n${log}`, envWithTools());
    return normalize(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

async function viaClaude(log, model) {
  const args = ['-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA)];
  args.push('--no-session-persistence', '--tools', '', '--strict-mcp-config', '--system-prompt', 'You turn activity logs into short recaps. Reply only with the requested JSON.');
  const out = JSON.parse(await runCli('claude', args, `${INSTRUCTIONS}\n\n----- LOG -----\n${log}`, envWithTools()));
  if (out.is_error) throw new Error(out.result || 'Claude Code failed');
  return normalize(out.structured_output ?? out.result);
}

// ---------- choosing ----------

export function planEngines(choice, settings = readSettings()) {
  if (choice && choice !== 'auto') return [choice];
  const ready = {
    openrouter: Boolean(secret('openrouter')),
    local: Boolean(settings.local.baseUrl && settings.local.model),
    codex: true,
    claude: true,
  };
  return ['openrouter', 'local', 'codex', 'claude'].filter((e) => ready[e]);
}

// makeLog(maxChars) builds the log; local models get a tighter one.
export async function summarize(makeLog, { engine, model } = {}) {
  fs.mkdirSync(WORK, { recursive: true });
  const settings = readSettings();
  const engines = planEngines(engine || settings.engine, settings);
  const failures = [];
  for (const name of engines) {
    try {
      let result;
      let used;
      if (name === 'openrouter') {
        const key = secret('openrouter');
        if (!key) throw new Error('not connected');
        used = model || settings.model;
        result = await viaChat({
          name: 'OpenRouter',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          key,
          model: used,
          headers: { 'X-Title': 'Recap', 'HTTP-Referer': 'https://github.com/erphq/recap' },
          extra: { provider: { require_parameters: true } },
          log: makeLog(),
          timeoutMs: CLI_TIMEOUT_MS,
        });
      } else if (name === 'local') {
        const { baseUrl, maxChars } = settings.local;
        used = model || settings.local.model;
        if (!baseUrl || !used) throw new Error('set a server address and model in Settings');
        result = await viaChat({ name: 'The local model', url: chatUrl(baseUrl), key: secret('local'), model: used, log: makeLog(maxChars), timeoutMs: LOCAL_TIMEOUT_MS });
      } else if (name === 'codex') {
        used = model || settings.codexModel || null;
        result = await viaCodex(makeLog(), used);
      } else if (name === 'claude') {
        used = model || 'sonnet';
        result = await viaClaude(makeLog(), used);
      } else {
        throw new Error(`unknown engine "${name}"`);
      }
      const warning = failures.length ? `${failures.join('; ')}. Used ${LABEL[name]} instead.` : null;
      return { ...result, engine: name, model: used, warning };
    } catch (err) {
      failures.push(`${LABEL[name] || name} failed: ${err.message}`);
    }
  }
  throw new Error(failures.join('; ') || 'No summarizer is set up');
}

// Lists the models an OpenAI-compatible server offers (Settings → Check).
export async function listModels(baseUrl, key) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  let res;
  try {
    res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(`Couldn't reach ${url} (${err.cause?.code || err.message})`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const json = await res.json().catch(() => ({}));
  return (json.data || json.models || []).map((m) => m.id || m.name || m.model).filter(Boolean);
}
