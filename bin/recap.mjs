#!/usr/bin/env node
// recap: one-line recap of what you did across Claude Code, Codex and git.
import fs from 'node:fs';
import path from 'node:path';
import { collect, digest, hm, sessionRefs, windowFor } from '../lib/collect.mjs';
import { summarize } from '../lib/summarize.mjs';
import { CACHE } from '../lib/paths.mjs';
import { toMarkdown, toText } from '../lib/render.mjs';
import { waitingNow } from '../lib/needs.mjs';

// Piping into head or similar closes stdout early; that is not an error.
process.stdout.on('error', (err) => err.code === 'EPIPE' && process.exit(0));

const HELP = `recap [range] [options]   one-line recap of the window
recap needs [range]       chats waiting on you now (no model involved)

  range            3h, 6h (default), 12h, 24h, 2d, today
  --hours N        same as "Nh"
  --format F       text (default in a terminal), md (default otherwise), json
  --digest         print the collected log instead of summarizing it
  --engine E       auto, openrouter, local, codex or claude (default: from settings;
                   auto tries OpenRouter, your local model, Codex, then Claude Code)
  --model M        model for that engine (default: from settings)
  --progress       print progress to stderr
`;

function parseArgs(argv) {
  const opts = { range: '6h', format: process.stdout.isTTY ? 'text' : 'md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--range') opts.range = next();
    else if (a === '--hours') opts.range = `${next()}h`;
    else if (a === '--today') opts.range = 'today';
    else if (a === '--format') opts.format = next();
    else if (a === '--digest') opts.digest = true;
    else if (a === '--engine') opts.engine = next();
    else if (a === '--model') opts.model = next();
    else if (a === '--progress') opts.progress = true;
    else if (a === 'needs') opts.needs = true;
    else if (!a.startsWith('-')) opts.range = a;
    else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void process.stdout.write(HELP);
  const progress = (msg) => opts.progress && process.stderr.write(`progress: ${msg}\n`);
  if (opts.needs) return printNeeds(opts);

  const data = await collect({ range: opts.range, onProgress: progress });
  const log = digest(data);
  if (opts.digest) return void process.stdout.write(`${log}\n`);

  let summary = { needsYou: [], items: [], engine: null, model: null, warning: null };
  if (data.sessions.length) {
    progress('Summarizing');
    summary = await summarize((maxChars) => (maxChars ? digest(data, { maxChars }) : log), { engine: opts.engine, model: opts.model });
  }

  const rec = {
    version: 2,
    range: data.window.range,
    from: data.window.from.toISOString(),
    to: data.window.to.toISOString(),
    generatedAt: data.now.toISOString(),
    engine: summary.engine,
    model: summary.model,
    warning: summary.warning,
    stats: data.stats,
    needsYou: summary.needsYou,
    items: summary.items,
    sessions: sessionRefs(data),
  };
  rec.markdown = toMarkdown(rec);

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, `recap-${rec.range}.json`), JSON.stringify(rec, null, 2));

  if (opts.format === 'json') process.stdout.write(`${JSON.stringify(rec)}\n`);
  else if (opts.format === 'md') process.stdout.write(`${rec.markdown}\n`);
  else process.stdout.write(`${toText(rec, process.stdout.isTTY)}\n`);
}

async function printNeeds(opts) {
  const since = windowFor(opts.needs && opts.range === '6h' ? '24h' : opts.range).from.getTime();
  const list = (await waitingNow()).filter((n) => n.at >= since);
  if (opts.format === 'json') return void process.stdout.write(`${JSON.stringify(list)}\n`);
  if (!list.length) return void process.stdout.write('Nothing is waiting on you.\n');
  const app = { claude: 'Claude', codex: 'Codex' };
  for (const n of list) {
    if (opts.format === 'md') process.stdout.write(`- **${n.title}** (${app[n.app]}, ${hm(n.at)}): ${n.text}${n.link ? ` [open](${n.link})` : ''}\n`);
    else process.stdout.write(`${hm(n.at).padEnd(9)} ${app[n.app].padEnd(7)} ${n.title}\n          ${n.text}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`recap: ${err.message}\n`);
  process.exit(1);
});
