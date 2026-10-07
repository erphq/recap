// Recap lives in the menu bar: click the icon for a panel with the latest recap.
import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, nativeTheme, screen, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CACHE, ROOT } from '../lib/paths.mjs';
import { DEFAULT_MODEL, ENGINES, maskKey, readSettings, removeSecret, saveSecret, secret, secretFromEnv, writeSettings } from '../lib/settings.mjs';
import { listModels } from '../lib/summarize.mjs';
import { Notifier } from './notifier.mjs';
import { cancelConnect, connectOpenRouter, keyInfo, structuredModels } from './openrouter-connect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(ROOT, 'bin', 'recap.mjs');
const RANGES = [
  ['3h', 'Last 3 hours'],
  ['6h', 'Last 6 hours'],
  ['12h', 'Last 12 hours'],
  ['today', 'Today'],
  ['24h', 'Last 24 hours'],
];
const WIDTH = 540;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 680;

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const shotPath = flag('screenshot');
const demo = process.argv.includes('--demo'); // made-up data, for screenshots and trying the app
if (flag('theme')) nativeTheme.themeSource = flag('theme');
const inBundle = /Recap\.app\/Contents\/MacOS\//.test(process.execPath);

// Keep the app's own data in the project folder, next to the recaps.
app.setName('Recap');
app.setPath('userData', path.join(CACHE, 'electron'));
if (!shotPath && !app.requestSingleInstanceLock()) app.quit();

let tray = null;
let win = null;
let job = null;
const notifier = new Notifier();
let height = 520;
let hiddenAt = 0;
let shownAt = 0;

// ---------- recap runs ----------

function demoRecap() {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'demo.json'), 'utf8'));
  const now = Date.now();
  return { ...d, from: new Date(now - 6 * 3_600_000).toISOString(), to: new Date(now).toISOString(), generatedAt: new Date(now - 60_000).toISOString(), markdown: '' };
}

function readCache(range) {
  if (demo) return demoRecap();
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE, `recap-${range}.json`), 'utf8'));
  } catch {
    return null;
  }
}

const lastLine = (s) =>
  String(s)
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('progress:'))
    .pop() || '';

function refresh(range) {
  if (demo) return Promise.resolve(demoRecap());
  if (job?.range === range) return job.promise;
  if (job) job.cancel();
  const child = spawn(process.execPath, [CLI, range, '--format', 'json', '--progress'], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let stdout = '';
  let stderr = '';
  let cancelled = false;
  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => {
      stderr += b;
      for (const line of String(b).split('\n')) {
        if (line.startsWith('progress: ')) win?.webContents.send('recap:progress', { range, message: line.slice(10) });
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (job?.child === child) job = null;
      if (cancelled) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error(lastLine(stderr).replace(/^recap: /, '') || 'Recap failed'));
      try {
        resolve(JSON.parse(lastLine(stdout)));
      } catch {
        reject(new Error('Recap returned something unreadable'));
      }
    });
  });
  job = {
    range,
    child,
    promise,
    cancel: () => {
      cancelled = true;
      child.kill('SIGTERM');
    },
  };
  return promise;
}

// ---------- settings ----------

const loginOn = () => (inBundle ? app.getLoginItemSettings().openAtLogin : null);

async function settingsState({ check = true } = {}) {
  const s = readSettings();
  const key = secret('openrouter');
  const info = key && check ? await keyInfo(key) : {};
  return {
    engine: s.engine,
    openrouter: key ? { connected: true, masked: maskKey(key), fromEnv: secretFromEnv('openrouter'), ...info } : { connected: false },
    model: s.model,
    defaultModel: DEFAULT_MODEL,
    local: { baseUrl: s.local.baseUrl, model: s.local.model, hasKey: Boolean(secret('local')), keyFromEnv: secretFromEnv('local') },
    notify: Boolean(s.notify),
    openAtLogin: loginOn(),
  };
}

function setNotify(on) {
  writeSettings({ notify: Boolean(on) });
  if (on) {
    notifier.start({ quiet: true });
    notifier.test();
  } else notifier.stop();
}

// ---------- panel ----------

function send(channel, payload) {
  win?.webContents.send(channel, payload);
}

function createPanel() {
  win = new BrowserWindow({
    width: WIDTH,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#fbfbfa',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const query = {};
  if (shotPath) query.shot = '1';
  if (flag('range')) query.range = flag('range');
  if (flag('view')) query.view = flag('view');
  win.loadFile(path.join(HERE, 'index.html'), { query });
  win.on('blur', () => {
    if (shotPath || win.webContents.isDevToolsOpened()) return;
    // Launching or activating can bounce focus once right after the panel opens.
    if (Date.now() - shownAt < 700) {
      app.focus({ steal: true });
      win.focus();
      return;
    }
    hiddenAt = Date.now();
    win.hide();
  });
  win.on('closed', () => (win = null));
}

function placePanel() {
  if (!win) return;
  const bounds = tray?.getBounds();
  const placed = bounds && bounds.width > 0;
  const point = placed ? { x: bounds.x, y: bounds.y } : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const center = placed ? bounds.x + bounds.width / 2 : area.x + area.width - WIDTH / 2 - 12;
  const x = Math.round(Math.max(area.x + 8, Math.min(center - WIDTH / 2, area.x + area.width - WIDTH - 8)));
  win.setBounds({ x, y: area.y + 6, width: WIDTH, height });
}

function showPanel() {
  if (!win) createPanel();
  placePanel();
  shownAt = Date.now();
  app.focus({ steal: true });
  win.show();
  win.focus();
  send('recap:shown');
}

function togglePanel() {
  // A click on the icon first blurs (and hides) an open panel; don't reopen it.
  if (win?.isVisible()) return win.hide();
  if (Date.now() - hiddenAt < 300) return;
  showPanel();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Recap', click: showPanel },
    { label: 'Refresh', click: () => (showPanel(), send('recap:command', 'refresh')) },
    { label: 'Settings…', click: () => (showPanel(), send('recap:command', 'settings')) },
    { type: 'separator' },
    { label: 'Notify When a Chat Needs Me', type: 'checkbox', checked: notifier.running, click: (item) => setNotify(item.checked) },
    {
      label: 'Open at Login',
      type: 'checkbox',
      enabled: inBundle,
      checked: Boolean(loginOn()),
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Recap', role: 'quit' },
  ]);
}

// macOS adds new menu bar icons on the far left, where a crowded bar hides them
// behind the notch. Ask for a spot near the clock until the person moves it.
const POSITION_KEY = 'NSStatusItem Preferred Position Item-0';

function createTray() {
  if (!systemPreferences.getUserDefault(POSITION_KEY, 'float')) systemPreferences.setUserDefault(POSITION_KEY, 'float', 440);
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Recap');
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

// Shortcuts work while the panel has focus; Edit lets ⌘V paste a key.
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Recap',
        submenu: [
          { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('recap:command', 'refresh') },
          { label: 'Copy as Markdown', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('recap:command', 'copy') },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('recap:command', 'settings') },
          { type: 'separator' },
          ...RANGES.map(([key, label], i) => ({ label, accelerator: `CmdOrCtrl+${i + 1}`, click: () => send('recap:command', `range:${key}`) })),
        ],
      },
      { role: 'editMenu' },
    ]),
  );
}

// ---------- IPC ----------

ipcMain.handle('recap:load', (_e, range) => (RANGES.some(([k]) => k === range) ? readCache(range) : null));
ipcMain.handle('recap:refresh', (_e, range) => {
  if (!RANGES.some(([k]) => k === range)) throw new Error(`Unknown range ${range}`);
  return refresh(range);
});
ipcMain.handle('recap:copy', (_e, text) => clipboard.writeText(String(text || '')));
ipcMain.on('recap:hide', () => win?.hide());
ipcMain.handle('recap:open', (_e, url) => {
  if (!/^(claude|codex):\/\//.test(String(url))) throw new Error('Not a chat link');
  win?.hide();
  return shell.openExternal(url);
});

// The icons of the apps that open claude:// and codex:// links, as the sources' logos.
const appIcons = {};
ipcMain.handle('recap:app-icons', async () => {
  for (const [name, scheme] of [
    ['claude', 'claude://'],
    ['codex', 'codex://'],
  ]) {
    if (name in appIcons) continue;
    try {
      const info = await app.getApplicationInfoForProtocol(scheme);
      appIcons[name] = { name: info.name.replace(/\.app$/, ''), icon: info.icon.resize({ width: 32, height: 32 }).toDataURL() };
    } catch {
      appIcons[name] = null;
    }
  }
  return appIcons;
});
ipcMain.on('recap:height', (_e, h) => {
  const next = Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(h) || height)));
  if (Math.abs(next - height) < 2) return;
  height = next;
  if (win) win.setBounds({ ...win.getBounds(), height });
});

ipcMain.handle('settings:get', () => settingsState());
ipcMain.handle('settings:models', () => structuredModels());
ipcMain.handle('settings:connect', async () => {
  const key = await connectOpenRouter();
  saveSecret('openrouter', key);
  showPanel();
  return settingsState();
});
ipcMain.handle('settings:cancel-connect', () => cancelConnect());
ipcMain.handle('settings:save-key', async (_e, key) => {
  saveSecret('openrouter', key);
  const info = await keyInfo(secret('openrouter'));
  if (info.valid === false) {
    removeSecret('openrouter');
    throw new Error('OpenRouter did not accept that key');
  }
  return settingsState();
});
ipcMain.handle('settings:disconnect', () => {
  removeSecret('openrouter');
  return settingsState({ check: false });
});
ipcMain.handle('settings:set-model', async (_e, raw) => {
  const model = String(raw || '').trim() || DEFAULT_MODEL;
  const models = await structuredModels();
  if (models.length && !models.some((m) => m.id === model)) throw new Error(`OpenRouter has no model "${model}" that returns structured output`);
  writeSettings({ model });
  return settingsState({ check: false });
});
ipcMain.handle('settings:set-engine', (_e, engine) => {
  if (!ENGINES.includes(engine)) throw new Error(`Unknown summarizer "${engine}"`);
  writeSettings({ engine });
  return settingsState({ check: false });
});
ipcMain.handle('settings:set-local', (_e, { baseUrl, model } = {}) => {
  const url = String(baseUrl ?? readSettings().local.baseUrl).trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error('The server address should start with http:// or https://');
  writeSettings({ local: { baseUrl: url, model: String(model ?? readSettings().local.model).trim() } });
  return settingsState({ check: false });
});
ipcMain.handle('settings:save-local-key', (_e, key) => {
  if (String(key || '').trim()) saveSecret('local', key);
  else removeSecret('local');
  return settingsState({ check: false });
});
ipcMain.handle('settings:check-local', async () => {
  const { baseUrl } = readSettings().local;
  if (!baseUrl) throw new Error('Add the server address first');
  return listModels(baseUrl, secret('local'));
});
ipcMain.handle('settings:set-notify', (_e, on) => {
  setNotify(on);
  return settingsState({ check: false });
});
ipcMain.handle('settings:set-login', (_e, on) => {
  if (inBundle) app.setLoginItemSettings({ openAtLogin: Boolean(on) });
  return settingsState({ check: false });
});
ipcMain.handle('app:quit', () => app.quit());

ipcMain.on('recap:rendered', () => {
  if (!shotPath || !win) return;
  setTimeout(async () => {
    if (process.env.RECAP_PROBE) console.log(JSON.stringify(await win.webContents.executeJavaScript(process.env.RECAP_PROBE)));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(shotPath, image.toPNG());
    app.quit();
  }, 700);
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  app.dock?.hide();
  buildMenu();
  if (shotPath) {
    createPanel();
    win.setBounds({ x: 80, y: 80, width: WIDTH, height });
    win.showInactive();
    return;
  }
  createTray();
  createPanel();
  if (readSettings().notify) notifier.start();
  // Wait a moment so the menu bar icon has a position to open under.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) win.once('ready-to-show', () => setTimeout(showPanel, 300));
});
app.on('second-instance', () => setTimeout(showPanel, 300));
app.on('activate', showPanel);
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  notifier.stop();
  job?.cancel();
  cancelConnect();
});
