// "Connect OpenRouter": OpenRouter's PKCE sign-in with a one-off localhost
// callback. The person approves in their browser and OpenRouter hands back a
// key that belongs to their account.
import http from 'node:http';
import crypto from 'node:crypto';
import { shell } from 'electron';

const TIMEOUT_MS = 5 * 60 * 1000;

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>Recap</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fbfbfa; color: #1d1d1f;
         font: 15px/22px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #ececee; } }
  main { max-width: 360px; padding: 24px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
  p { margin: 0; opacity: .6; }
</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

let active = null;

export function cancelConnect() {
  active?.(new Error('cancelled'));
}

export function connectOpenRouter() {
  cancelConnect();
  return new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const servers = [];
    let done = false;

    const finish = (err, key) => {
      if (done) return;
      done = true;
      active = null;
      clearTimeout(timer);
      setTimeout(() => servers.forEach((s) => s.close()), 500);
      if (err) reject(err);
      else resolve(key);
    };
    active = (err) => finish(err);
    const timer = setTimeout(() => finish(new Error('No answer from OpenRouter within 5 minutes')), TIMEOUT_MS);

    const handler = async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const send = (title, body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, body));
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('state') !== state) {
        send('Not connected', 'Recap did not get access. You can close this tab.');
        return finish(new Error('OpenRouter access was not granted'));
      }
      try {
        const r = await fetch('https://openrouter.ai/api/v1/auth/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.key) throw new Error(body?.error?.message || `OpenRouter answered ${r.status}`);
        send('Recap is connected', 'Your OpenRouter account now writes your recaps. You can close this tab.');
        finish(null, body.key);
      } catch (err) {
        send('Not connected', 'Something went wrong. Try again from Recap.');
        finish(err);
      }
    };

    // Listen on both loopback addresses: browsers may resolve "localhost" to either.
    const v4 = http.createServer(handler);
    servers.push(v4);
    v4.on('error', (err) => finish(err));
    v4.listen(0, '127.0.0.1', () => {
      const { port } = v4.address();
      const v6 = http.createServer(handler);
      v6.on('error', () => {}); // no IPv6 loopback on this machine; IPv4 is enough
      v6.listen(port, '::1');
      servers.push(v6);
      const params = new URLSearchParams({
        callback_url: `http://localhost:${port}/callback`,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        key_label: 'Recap',
      });
      shell.openExternal(`https://openrouter.ai/auth?${params}`);
    });
  });
}

// Label and spend for the connected key, for the settings screen.
export async function keyInfo(key) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return { valid: false };
    const body = await r.json();
    return { valid: true, label: body?.data?.label || null, usage: body?.data?.usage ?? null, limit: body?.data?.limit ?? null };
  } catch {
    return { valid: null };
  }
}

let modelCache = null;

// Models that can return strict JSON, for the model picker.
export async function structuredModels() {
  if (modelCache) return modelCache;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) });
    const { data } = await r.json();
    modelCache = data
      .filter((m) => (m.supported_parameters || []).includes('structured_outputs'))
      .map((m) => ({ id: m.id, name: m.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    modelCache = null;
  }
  return modelCache || [];
}
