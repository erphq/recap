// Settings shared by the app and the CLI. API keys live in the macOS Keychain;
// everything else sits in settings.json in the project folder.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

const FILE = process.env.RECAP_SETTINGS || path.join(ROOT, 'settings.json');

export const DEFAULT_MODEL = 'openai/gpt-6-luna';
export const ENGINES = ['auto', 'openrouter', 'local', 'codex', 'claude'];

const DEFAULTS = {
  engine: 'auto',
  model: DEFAULT_MODEL, // OpenRouter model
  local: { baseUrl: '', model: '', maxChars: 32_000 },
  codexModel: 'gpt-5.6-luna',
  notify: false,
};

export function readSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* first run */
  }
  return { ...DEFAULTS, ...saved, local: { ...DEFAULTS.local, ...(saved.local || {}) } };
}

export function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current, ...patch, local: { ...current.local, ...(patch.local || {}) } };
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------- secrets ----------

const SECRETS = {
  openrouter: { service: 'Recap OpenRouter', label: 'Recap: OpenRouter key', env: 'OPENROUTER_API_KEY' },
  local: { service: 'Recap Local Model', label: 'Recap: local model key', env: 'RECAP_LOCAL_API_KEY' },
};
const ACCOUNT = 'api-key';

export function secret(name) {
  const s = SECRETS[name];
  if (process.env[s.env]) return process.env[s.env];
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', s.service, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null; // not set, or not on macOS
  }
}

export const secretFromEnv = (name) => Boolean(process.env[SECRETS[name].env]);

export function saveSecret(name, value) {
  const s = SECRETS[name];
  const v = String(value || '').trim();
  if (!v || /["\\\n\r]/.test(v)) throw new Error("That key can't be saved");
  if (name === 'openrouter' && !/^sk-or-[A-Za-z0-9_-]{16,}$/.test(v)) throw new Error("That doesn't look like an OpenRouter key; they start with sk-or-");
  // Sent through stdin so the key never appears in the process list.
  const command = `add-generic-password -U -s "${s.service}" -a "${ACCOUNT}" -l "${s.label}" -w "${v}"\n`;
  const r = spawnSync('/usr/bin/security', ['-i'], { input: command, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || secret(name) !== v) throw new Error("Couldn't save the key to the Keychain");
}

export function removeSecret(name) {
  spawnSync('/usr/bin/security', ['delete-generic-password', '-s', SECRETS[name].service, '-a', ACCOUNT], { stdio: 'ignore' });
}

export const maskKey = (k) => (k ? `${k.slice(0, Math.min(9, Math.floor(k.length / 3)))}…${k.slice(-4)}` : null);
