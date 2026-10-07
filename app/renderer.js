const RANGES = [
  ['3h', '3h'],
  ['6h', '6h'],
  ['12h', '12h'],
  ['today', 'Today'],
  ['24h', '24h'],
];
const STALE_MS = 15 * 60 * 1000;
const STATE_LABEL = { running: 'Running', waiting: 'Waiting on you' };
const ENGINE_LABEL = { openrouter: 'OpenRouter', codex: 'Codex', claude: 'Claude Code' };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const shot = params.has('shot');

const state = {
  view: params.get('view') === 'settings' ? 'settings' : 'list',
  range: params.get('range') || savedRange(),
  rec: null,
  job: null, // { range, started, step }
  error: null,
  settings: null,
  icons: {},
  connecting: false,
  settingsError: null,
};

function savedRange() {
  try {
    const r = localStorage.getItem('recap.range');
    if (RANGES.some(([k]) => k === r)) return r;
  } catch {
    /* storage unavailable */
  }
  return '6h';
}

function saveRange(r) {
  try {
    localStorage.setItem('recap.range', r);
  } catch {
    /* storage unavailable */
  }
}

function hm(d, now = new Date()) {
  const date = new Date(d);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return `at ${hm(iso)}`;
}

const busy = () => state.job?.range === state.range;
const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// The panel grows and shrinks with its content.
new ResizeObserver(() => window.recap.setHeight(document.body.offsetHeight)).observe(document.body);

// ---------- list view ----------

const needText = (n) => (typeof n === 'string' ? n : n.text);

// The chats a line came from, one per app: the most recent one that can be opened.
function sourcesFor(numbers) {
  const refs = new Map((state.rec?.sessions || []).map((r) => [r.n, r]));
  const best = new Map();
  for (const n of numbers || []) {
    const r = refs.get(n);
    if (!r) continue;
    const cur = best.get(r.app);
    const better = !cur || (Boolean(r.link) && !cur.link) || (Boolean(r.link) === Boolean(cur.link) && r.last > cur.last);
    if (better) best.set(r.app, r);
  }
  return [...best.values()];
}

function sourceIcons(numbers) {
  const box = el('span', 'srcs');
  for (const src of sourcesFor(numbers)) {
    const meta = state.icons?.[src.app];
    const appName = meta?.name || (src.app === 'claude' ? 'Claude' : 'Codex');
    const title = src.title ? `“${src.title}”` : 'this chat';
    const node = src.link ? button('', 'src', () => window.recap.open(src.link)) : el('span', 'src off');
    node.title = src.link ? `Open ${title} in ${appName}` : `${title}, ${src.helper ? 'a helper job' : 'run in the terminal'}`;
    if (src.link) node.setAttribute('aria-label', node.title);
    if (meta?.icon) {
      const img = el('img');
      img.src = meta.icon;
      img.alt = '';
      node.append(img);
    } else node.textContent = appName[0];
    box.append(node);
  }
  return box;
}

function renderRanges() {
  const box = $('ranges');
  if (!box.children.length) {
    for (const [key, label] of RANGES) {
      const b = button(label, null, () => selectRange(key));
      b.setAttribute('role', 'tab');
      b.dataset.range = key;
      box.append(b);
    }
  }
  for (const b of box.children) b.setAttribute('aria-selected', String(b.dataset.range === state.range));
}

function renderMeta() {
  const meta = $('meta');
  meta.replaceChildren();
  meta.removeAttribute('title');
  if (busy()) {
    const secs = Math.floor((Date.now() - state.job.started) / 1000);
    meta.textContent = `${state.job.step}… ${secs}s`;
  } else if (state.error) {
    meta.append(el('span', 'error', `Couldn't refresh: ${state.error}`), button('Try again', 'link', refresh));
  } else if (state.rec) {
    const r = state.rec;
    const now = new Date(r.generatedAt);
    meta.append(`${hm(r.from, now)} – ${hm(r.to, now)}  ·  ${r.stats.sessions} sessions  ·  ${r.stats.commits} commits  ·  updated ${ago(r.generatedAt)}`);
    if (r.engine) meta.title = `Written by ${r.model} on ${ENGINE_LABEL[r.engine] || r.engine}`;
    if (r.warning) meta.append(el('span', 'warning', r.warning));
  }
  document.body.classList.toggle('busy', busy());
  $('copy').disabled = !state.rec;
}

function renderSkeleton() {
  const groups = $('groups');
  groups.replaceChildren();
  const section = el('section', 'group');
  const list = el('ul', 'list');
  for (const w of [78, 64, 86, 58, 72]) {
    const row = el('li', 'row skeleton');
    const line = el('span', 'line');
    line.style.flex = '1';
    const bar = el('div', 'bar-sk');
    bar.style.width = `${w}%`;
    line.append(bar);
    row.append(el('span', 'dot'), line);
    list.append(row);
  }
  section.append(list);
  groups.append(section);
  $('needs').hidden = true;
  $('empty').hidden = true;
}

function renderList(animate) {
  const rec = state.rec;
  let i = 0;
  const enter = (node) => {
    if (animate) {
      node.classList.add('enter');
      node.style.setProperty('--i', String(i++));
    }
    return node;
  };

  const needs = $('needs-list');
  needs.replaceChildren();
  $('needs').hidden = !rec.needsYou.length;
  for (const need of rec.needsYou) {
    const row = enter(el('li', 'row'));
    row.append(el('span', 'dot'), el('span', 'line', needText(need)), sourceIcons(need.sessions));
    needs.append(row);
  }

  // One section per project, in the order the summary gave them.
  const groups = $('groups');
  groups.replaceChildren();
  const byTag = new Map();
  for (const it of rec.items) {
    if (!byTag.has(it.tag)) byTag.set(it.tag, []);
    byTag.get(it.tag).push(it);
  }
  for (const [tag, items] of byTag) {
    const section = el('section', 'group');
    section.append(enter(el('h2', null, tag)));
    const list = el('ul', 'list');
    for (const it of items) {
      const row = enter(el('li', `row ${it.status}`));
      const dot = el('span', 'dot');
      if (STATE_LABEL[it.status]) {
        row.title = STATE_LABEL[it.status];
        dot.setAttribute('aria-label', STATE_LABEL[it.status]);
      }
      row.append(dot, el('span', 'line', it.line), sourceIcons(it.sessions));
      list.append(row);
    }
    section.append(list);
    groups.append(section);
  }

  const empty = $('empty');
  empty.hidden = rec.items.length > 0;
  empty.textContent = state.range === 'today' ? 'Nothing yet today.' : `Nothing in the last ${state.range.replace('h', ' hours')}.`;
}

// ---------- settings view ----------

function renderSettings() {
  const s = state.settings;
  const or = s?.openrouter || { connected: false };
  const sub = $('or-sub');
  const control = $('or-control');
  control.replaceChildren();

  if (state.connecting) {
    sub.textContent = 'Finish signing in in your browser…';
    control.append(button('Cancel', 'btn', () => window.recap.settings.cancelConnect()));
  } else if (or.connected) {
    const parts = ['Connected', or.masked];
    if (or.fromEnv) parts[0] = 'From OPENROUTER_API_KEY';
    if (typeof or.usage === 'number') parts.push(`$${or.usage.toFixed(2)} used`);
    if (or.valid === false) parts[0] = 'Key no longer works';
    sub.textContent = parts.join(' · ');
    const off = button('Disconnect', 'btn', disconnect);
    off.disabled = Boolean(or.fromEnv);
    control.append(off);
  } else {
    sub.textContent = 'Not connected';
    control.append(button('Connect', 'btn primary', connect));
  }
  $('or-paste').hidden = or.connected || state.connecting;

  const model = $('model');
  if (s && document.activeElement !== model) model.value = s.model;
  model.placeholder = s?.defaultModel || '';

  const engine = s?.engine || 'auto';
  $('engine').value = engine;
  const local = s?.local || {};
  const onDevice = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(local.baseUrl || '');
  $('engine-sub').textContent = {
    auto: 'OpenRouter, your local model, Codex, then Claude Code',
    openrouter: or.connected ? 'Your OpenRouter account' : 'Connect OpenRouter below',
    local: local.baseUrl && local.model ? (onDevice ? 'Your local model; nothing leaves this Mac' : 'Your own server') : 'Set up the server below',
    codex: 'The Codex CLI on this Mac',
    claude: 'The Claude Code CLI on this Mac',
  }[engine];

  for (const [id, value] of [
    ['local-url', local.baseUrl],
    ['local-model', local.model],
  ]) {
    if (s && document.activeElement !== $(id)) $(id).value = value || '';
  }
  $('local-key').placeholder = local.keyFromEnv ? 'From RECAP_LOCAL_API_KEY' : local.hasKey ? 'Saved in Keychain' : 'Optional';
  $('local-key').disabled = Boolean(local.keyFromEnv);

  $('notify').checked = Boolean(s?.notify);

  const err = $('set-error');
  err.hidden = !state.settingsError;
  err.textContent = state.settingsError || '';

  const login = $('login');
  login.disabled = s?.openAtLogin == null;
  login.checked = Boolean(s?.openAtLogin);
  $('login-sub').hidden = s?.openAtLogin != null;
  $('login-sub').textContent = 'Available in Recap.app';
}

async function loadSettings() {
  try {
    state.settings = await window.recap.settings.get();
  } catch (err) {
    state.settingsError = cleanError(err);
  }
  renderSettings();
  const models = await window.recap.settings.models().catch(() => []);
  const list = $('models');
  if (!list.children.length) {
    for (const m of models) {
      const opt = el('option');
      opt.value = m.id;
      opt.label = m.name;
      list.append(opt);
    }
  }
}

async function settingsAction(fn) {
  state.settingsError = null;
  try {
    state.settings = await fn();
  } catch (err) {
    const msg = cleanError(err);
    if (msg !== 'cancelled') state.settingsError = msg;
  }
  renderSettings();
}

async function connect() {
  state.connecting = true;
  renderSettings();
  await settingsAction(() => window.recap.settings.connect());
  state.connecting = false;
  renderSettings();
}

function disconnect() {
  settingsAction(() => window.recap.settings.disconnect());
}

async function saveKey() {
  const input = $('or-key');
  if (!input.value.trim()) return;
  await settingsAction(() => window.recap.settings.saveKey(input.value));
  if (!state.settingsError) input.value = '';
}

async function saveModel() {
  const model = $('model');
  if (model.value.trim() === state.settings?.model) return;
  await settingsAction(() => window.recap.settings.setModel(model.value));
  if (!state.settingsError) {
    flash('model-sub', 'Saved');
  }
}

// Shows a short confirmation in a row's subtitle, then puts the subtitle back.
const flashTimers = {};
function flash(id, text) {
  const node = $(id);
  node.dataset.text ??= node.textContent;
  node.textContent = text;
  clearTimeout(flashTimers[id]);
  flashTimers[id] = setTimeout(() => (node.textContent = node.dataset.text), 1800);
}

async function saveLocal(field) {
  const value = $(field === 'baseUrl' ? 'local-url' : 'local-model').value.trim();
  if (value === (state.settings?.local?.[field] || '')) return;
  await settingsAction(() => window.recap.settings.setLocal({ [field]: value }));
}

async function saveLocalKey() {
  const input = $('local-key');
  await settingsAction(() => window.recap.settings.saveLocalKey(input.value));
  if (!state.settingsError) {
    flash('local-key-sub', input.value.trim() ? 'Saved in Keychain' : 'Removed');
    input.value = '';
  }
}

async function checkLocal() {
  state.settingsError = null;
  $('local-check').disabled = true;
  try {
    const models = await window.recap.settings.checkLocal();
    const list = $('local-models');
    list.replaceChildren(...models.map((id) => Object.assign(el('option'), { value: id })));
    flash('local-sub', models.length ? `Connected · ${models.length} model${models.length === 1 ? '' : 's'}` : 'Connected, but it has no models yet');
  } catch (err) {
    state.settingsError = cleanError(err);
  }
  $('local-check').disabled = false;
  renderSettings();
}

// ---------- shared ----------

function render(animate = false) {
  document.body.classList.toggle('settings', state.view === 'settings');
  $('list-view').hidden = state.view !== 'list';
  $('settings-view').hidden = state.view !== 'settings';
  renderRanges();
  renderMeta();
  document.body.classList.toggle('has-data', Boolean(state.rec));
  if (state.rec) renderList(animate);
  else if (busy()) renderSkeleton();
  if (state.view === 'settings') renderSettings();
}

function showView(view) {
  state.view = view;
  if (view === 'settings') loadSettings();
  render();
  window.scrollTo(0, 0);
}

async function refresh() {
  if (busy()) return;
  const range = state.range;
  state.job = { range, started: Date.now(), step: 'Reading sessions' };
  state.error = null;
  render();
  try {
    const rec = await window.recap.refresh(range);
    if (state.job?.range === range) state.job = null;
    if (range !== state.range) return;
    state.rec = rec;
    render(true);
  } catch (err) {
    if (state.job?.range === range) state.job = null;
    if (range !== state.range) return;
    const msg = cleanError(err);
    if (msg === 'cancelled') return;
    state.error = msg;
    render();
  }
}

const stale = () => !state.rec || Date.now() - new Date(state.rec.generatedAt) > STALE_MS;

async function selectRange(range) {
  if (range === state.range && state.rec) return;
  state.range = range;
  state.error = null;
  saveRange(range);
  state.rec = await window.recap.load(range);
  render(true);
  if (stale()) refresh();
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

async function copy() {
  if (!state.rec) return;
  await window.recap.copy(state.rec.markdown);
  toast('Copied');
}

// ---------- wiring ----------

$('refresh').addEventListener('click', refresh);
$('copy').addEventListener('click', copy);
$('open-settings').addEventListener('click', () => showView('settings'));
$('back').addEventListener('click', () => showView('list'));
$('or-save').addEventListener('click', saveKey);
$('or-key').addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());
$('model').addEventListener('change', saveModel);
$('login').addEventListener('change', (e) => settingsAction(() => window.recap.settings.setLogin(e.target.checked)));
$('notify').addEventListener('change', (e) => settingsAction(() => window.recap.settings.setNotify(e.target.checked)));
$('engine').addEventListener('change', (e) => settingsAction(() => window.recap.settings.setEngine(e.target.value)));
$('local-url').addEventListener('change', () => saveLocal('baseUrl'));
$('local-model').addEventListener('change', () => saveLocal('model'));
$('local-key').addEventListener('change', saveLocalKey);
$('local-check').addEventListener('click', checkLocal);
$('quit').addEventListener('click', () => window.recap.settings.quit());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.view === 'settings') showView('list');
  else window.recap.hide();
});

window.recap.onProgress(({ range, message }) => {
  if (state.job?.range === range) {
    state.job.step = message;
    renderMeta();
  }
});

window.recap.onCommand((cmd) => {
  if (cmd === 'copy') return void copy();
  if (cmd === 'settings') return void showView('settings');
  if (state.view === 'settings') showView('list');
  if (cmd === 'refresh') refresh();
  else if (cmd.startsWith('range:')) selectRange(cmd.slice(6));
});

window.recap.onShown(() => {
  if (state.view === 'list' && stale() && !busy()) refresh();
});

window.addEventListener('scroll', () => $('bar').classList.toggle('scrolled', window.scrollY > 2), { passive: true });
setInterval(renderMeta, 1000);

(async () => {
  state.icons = await window.recap.appIcons().catch(() => ({}));
  state.rec = await window.recap.load(state.range);
  render(true);
  if (state.view === 'settings') await loadSettings();
  if (shot) {
    setTimeout(() => window.recap.rendered(), 150);
    return;
  }
  if (stale()) refresh();
})();
