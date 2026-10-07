import { hm } from './collect.mjs';

// Recaps written before needsYou carried session numbers stored plain strings.
export const needText = (n) => (typeof n === 'string' ? n : n.text);

const SUFFIX = { running: ' · running', waiting: ' · waiting on you', done: '' };

function header(rec) {
  const now = new Date(rec.generatedAt);
  const s = rec.stats;
  return `${hm(rec.from, now)}–${hm(rec.to, now)} · ${s.sessions} sessions · ${s.commits} commits`;
}

export function toMarkdown(rec) {
  const out = [`**Recap** · ${header(rec)}`, ''];
  if (rec.needsYou.length) {
    out.push('**Needs you**');
    for (const n of rec.needsYou) out.push(`- ${needText(n)}`);
    out.push('');
  }
  if (!rec.items.length) out.push('Nothing in this window.');
  for (const it of rec.items) out.push(`- **${it.tag}** ${it.line}${SUFFIX[it.status] || ''}`);
  return out.join('\n');
}

export function toText(rec, color = true) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dot = { running: c('32', '●'), waiting: c('33', '●'), done: c('2', '·') };
  const width = Math.max(0, ...rec.items.map((it) => it.tag.length));
  const out = [`${c('1', 'Recap')}  ${c('2', header(rec))}`, ''];
  if (rec.needsYou.length) {
    out.push(c('1', 'Needs you'));
    for (const n of rec.needsYou) out.push(`  ${c('33', '○')} ${needText(n)}`);
    out.push('');
  }
  if (!rec.items.length) out.push(c('2', '  Nothing in this window.'));
  let lastTag = null;
  for (const it of rec.items) {
    if (lastTag && it.tag !== lastTag) out.push('');
    const tag = it.tag === lastTag ? ' '.repeat(width) : it.tag.padEnd(width);
    out.push(`  ${dot[it.status] || dot.done} ${c('2', tag)}  ${it.line}`);
    lastTag = it.tag;
  }
  return out.join('\n');
}
