'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeTheme,
  Notification, powerSaveBlocker, systemPreferences, screen,
} = require('electron');

const { JsonFile } = require('./store');
const { Engine } = require('./engine');
const { DownloadManager } = require('./queue');
const { probe, QUALITIES, qualityOf } = require('./ytdlp');
const { extractLinks } = require('./links');

const APP_NAME = 'Hesta Downloader';
app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const DATA_DIR = app.getPath('userData');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

// ---------- settings ----------

const SETTINGS_DEFAULTS = {
  folder: app.getPath('downloads'),
  quality: '1080',
  container: 'auto',
  preferCompatible: true,
  playlistSubfolder: true,
  numberPlaylistItems: true,
  includeIdInName: true,
  concurrency: 3,
  rateLimit: '',
  cookiesBrowser: 'none',
  proxy: '',
  resumeOnLaunch: true,
  notify: true,
  autoUpdateEngine: true,
  watchClipboard: true,
  embedThumbnail: false,
  embedSubs: false,
  ffmpegPath: '',
};

const settingsFile = new JsonFile(path.join(DATA_DIR, 'settings.json'), SETTINGS_DEFAULTS);
const uiFile = new JsonFile(path.join(DATA_DIR, 'window.json'), {});
const settings = {
  get: () => settingsFile.data,
  set(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in SETTINGS_DEFAULTS)) continue;
      const t = typeof SETTINGS_DEFAULTS[k];
      if (t === 'number') clean[k] = Math.max(1, Math.min(10, Math.round(Number(v)) || SETTINGS_DEFAULTS[k]));
      else if (t === 'boolean') clean[k] = !!v;
      else clean[k] = String(v ?? '');
    }
    if (clean.rateLimit && !/^\d+(\.\d+)?[KMG]?$/i.test(clean.rateLimit)) clean.rateLimit = '';
    Object.assign(settingsFile.data, clean);
    settingsFile.save();
    broadcast('settings:changed', settingsFile.data);
    if ('concurrency' in clean) manager.pump();
    if ('cookiesBrowser' in clean) engine.clearCookies();
    return settingsFile.data;
  },
};

const engine = new Engine({ dataDir: DATA_DIR, settings });
const jobsFile = new JsonFile(path.join(DATA_DIR, 'downloads.json'), { version: 1, jobs: [] });
if (!Array.isArray(jobsFile.data.jobs)) jobsFile.data.jobs = [];
const manager = new DownloadManager({ engine, settings, store: jobsFile });

// ---------- windows ----------

let mainWindow = null;
let settingsWindow = null;
let quitting = false;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function hardenContents(contents) {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function validBounds(b) {
  if (!b || !b.width || !b.height) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50;
  });
  return visible ? b : null;
}

function createMainWindow() {
  const bounds = validBounds(uiFile.data.bounds) || {};
  mainWindow = new BrowserWindow({
    width: bounds.width || 1040,
    height: bounds.height || 680,
    x: bounds.x,
    y: bounds.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  hardenContents(mainWindow.webContents);
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const saveBounds = () => {
    if (!mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
      uiFile.data.bounds = mainWindow.getNormalBounds();
      uiFile.save(800);
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('focus', checkClipboard);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMain() {
  if (!mainWindow) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return mainWindow;
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Settings',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#f2f2f2',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  hardenContents(settingsWindow.webContents);
  settingsWindow.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- clipboard detection ----------

// Electron 44+ made clipboard.readText() async; await works for both forms.
async function readClipboard() {
  try {
    const text = await clipboard.readText();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

let lastClipboard = null;
readClipboard().then((t) => { if (lastClipboard === null) lastClipboard = t; });

async function checkClipboard() {
  if (!settings.get().watchClipboard || !mainWindow) return;
  const text = await readClipboard();
  if (!text || text === lastClipboard) return;
  lastClipboard = text;
  const links = extractLinks(text.slice(0, 200000));
  if (links.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clipboard:links', links);
}

// ---------- dock / power / notifications ----------

let powerBlocker = null;
manager.on('changed', (jobs) => broadcast('jobs:changed', jobs));
manager.on('summary', (s) => {
  broadcast('jobs:summary', s);
  if (app.dock) app.dock.setBadge(s.active + s.queued > 0 ? String(s.active + s.queued) : '');
  if (mainWindow) mainWindow.setProgressBar(s.active ? (s.progress >= 0 ? Math.min(1, s.progress) : 2) : -1);
  if (s.active && powerBlocker == null) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!s.active && powerBlocker != null) {
    powerSaveBlocker.stop(powerBlocker);
    powerBlocker = null;
  }
});

let completedBatch = [];
let notifyTimer = null;
function notify(title, body, job) {
  if (!settings.get().notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    showMain();
    if (job?.filepath) shell.showItemInFolder(job.filepath);
  });
  n.show();
}
manager.on('completed', (job) => {
  completedBatch.push(job);
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    const batch = completedBatch;
    completedBatch = [];
    if (mainWindow?.isFocused()) return;
    if (batch.length === 1) notify('Download complete', batch[0].title, batch[0]);
    else notify('Downloads complete', `${batch.length} videos downloaded`, batch[batch.length - 1]);
  }, 1500);
  if (app.dock && !mainWindow?.isFocused()) app.dock.bounce('informational');
});
manager.on('failed', (job) => {
  if (!mainWindow?.isFocused()) notify('Download failed', `${job.title}\n${job.error || ''}`);
});
manager.on('idle', () => engine.prune());

engine.on('status', (s) => {
  broadcast('engine:status', engine.info());
  if (s.ready) manager.pump();
});

// ---------- IPC ----------

const probes = new Map();

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

handle('app:init', () => ({
  settings: settings.get(),
  jobs: manager.list(),
  summary: manager.summary(),
  engine: engine.info(),
  qualities: QUALITIES,
  version: app.getVersion(),
  accent: systemPreferences.getAccentColor?.() || null,
}));

handle('links:parse', (text) => extractLinks(String(text || '').slice(0, 500000)));

handle('probe:start', async (token, link) => {
  if (!engine.status.ready) await engine.ensure().catch(() => {});
  const ctrl = new AbortController();
  probes.set(token, ctrl);
  try {
    return { ok: true, result: await probe(engine, link, { signal: ctrl.signal }) };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: String(err.message || err) };
  } finally {
    probes.delete(token);
  }
});
handle('probe:cancel', (token) => probes.get(token)?.abort());

handle('jobs:add', (items, opts) => {
  if (!Array.isArray(items) || !opts?.folder) return { added: 0, skipped: 0 };
  const quality = qualityOf(opts.quality) ? String(opts.quality) : settings.get().quality;
  return manager.add(items, { ...opts, quality });
});
handle('jobs:pause', (id) => manager.pause(id));
handle('jobs:resume', (id) => manager.resume(id));
handle('jobs:retry', (id) => manager.retry(id));
handle('jobs:remove', (id) => manager.remove(id));
handle('jobs:pauseAll', () => manager.pauseAll());
handle('jobs:resumeAll', () => manager.resumeAll());
handle('jobs:clearFinished', () => manager.clearFinished());

function jobFile(id) {
  const j = manager.get(id);
  return j?.filepath && fs.existsSync(j.filepath) ? j.filepath : null;
}
handle('file:open', async (id) => {
  const f = jobFile(id);
  if (!f) return false;
  return (await shell.openPath(f)) === '';
});
handle('file:reveal', (id) => {
  const f = jobFile(id);
  const j = manager.get(id);
  if (f) shell.showItemInFolder(f);
  else if (j) shell.openPath(j.subfolder ? path.join(j.folder, j.subfolder) : j.folder);
  return !!f;
});
handle('folder:open', (folder) => shell.openPath(folder || settings.get().folder));

handle('jobs:menu', (id) => {
  const j = manager.get(id);
  if (!j || !mainWindow) return;
  const file = jobFile(id);
  const active = ['downloading', 'processing', 'starting', 'queued'].includes(j.status);
  const template = [
    { label: 'Open', enabled: !!file, click: () => shell.openPath(file) },
    { label: 'Show in Finder', click: () => (file ? shell.showItemInFolder(file) : shell.openPath(j.folder)) },
    { type: 'separator' },
    active
      ? { label: 'Pause', click: () => manager.pause(id) }
      : j.status === 'completed'
        ? { label: 'Download Again', click: () => manager.retry(id) }
        : { label: j.status === 'failed' ? 'Retry' : 'Resume', click: () => manager.resume(id) },
    { type: 'separator' },
    { label: 'Copy Video Link', click: () => Promise.resolve(clipboard.writeText(j.url)).catch(() => {}) },
    { label: 'Open on YouTube', click: () => shell.openExternal(j.url) },
    ...(j.error ? [{ label: 'Copy Error Details', click: () => Promise.resolve(clipboard.writeText(`${j.error}\n\n${j.raw || ''}`)).catch(() => {}) }] : []),
    { type: 'separator' },
    { label: j.status === 'completed' ? 'Remove from List' : 'Cancel Download', click: () => manager.remove(id) },
  ];
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
});

handle('dialog:chooseFolder', async (current) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose Download Folder',
    buttonLabel: 'Choose',
    defaultPath: current || settings.get().folder,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('settings:get', () => settings.get());
handle('settings:set', (patch) => settings.set(patch));
handle('settings:open', () => openSettings());

handle('engine:info', () => engine.info());
handle('engine:update', async () => {
  try {
    return { ok: true, ...(await engine.update({ force: false })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
handle('engine:setup', async () => {
  try {
    await engine.ensure();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

handle('external:open', (url) => {
  if (/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|hesta\.io|github\.com)\//i.test(url)) shell.openExternal(url);
});

// ---------- menu ----------

function send(channel, payload) {
  const w = showMain();
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => w.webContents.send(channel, payload));
  else w.webContents.send(channel, payload);
}

function buildMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        {
          label: 'Check for Engine Updates…',
          click: async () => {
            try {
              const r = await engine.update({ force: false });
              dialog.showMessageBox(showMain(), {
                type: 'info',
                message: r.updated ? 'Download engine updated' : 'Download engine is up to date',
                detail: `yt-dlp ${r.version}`,
              });
            } catch (err) {
              dialog.showMessageBox(showMain(), { type: 'warning', message: 'Could not check for updates', detail: String(err.message || err) });
            }
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Download', accelerator: 'Cmd+N', click: () => send('menu', 'focus-url') },
        { label: 'Paste and Fetch', accelerator: 'Shift+Cmd+V', click: async () => send('menu:paste', await readClipboard()) },
        { type: 'separator' },
        { label: 'Open Download Folder', accelerator: 'Shift+Cmd+O', click: () => shell.openPath(settings.get().folder) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Downloads',
      submenu: [
        { label: 'Pause All', accelerator: 'Alt+Cmd+P', click: () => manager.pauseAll() },
        { label: 'Resume All', accelerator: 'Alt+Cmd+R', click: () => manager.resumeAll() },
        { type: 'separator' },
        { label: 'Clear Completed', accelerator: 'Alt+Cmd+K', click: () => manager.clearFinished() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'All Downloads', accelerator: 'Cmd+1', click: () => send('menu', 'filter:all') },
        { label: 'Active', accelerator: 'Cmd+2', click: () => send('menu', 'filter:active') },
        { label: 'Completed', accelerator: 'Cmd+3', click: () => send('menu', 'filter:completed') },
        { label: 'Failed', accelerator: 'Cmd+4', click: () => send('menu', 'filter:failed') },
        { type: 'separator' },
        ...(isDev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Hesta Website', click: () => shell.openExternal('https://hesta.io') },
        { label: 'Supported Links', click: () => send('menu', 'help-links') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------

app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} Hesta`,
    credits: 'Powered by yt-dlp and FFmpeg.',
    website: 'https://hesta.io',
    iconPath: ICON,
  });
  if (app.dock && !app.isPackaged && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  nativeTheme.themeSource = 'system';
  buildMenu();
  createMainWindow();
  engine.ensure().catch((err) => console.error('engine setup failed:', err.message));
});

app.on('activate', () => showMain());

// Keep running (and downloading) when the window is closed — standard macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  if (manager.hasActive()) {
    const choice = dialog.showMessageBoxSync(showMain(), {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Downloads are in progress',
      detail: settings.get().resumeOnLaunch !== false
        ? 'They will resume automatically from where they stopped next time you open Hesta Downloader.'
        : 'They will be paused and can be resumed later.',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
  }
  e.preventDefault();
  quitting = true;
  manager.shutdown().finally(() => {
    settingsFile.flush();
    uiFile.flush();
    app.exit(0);
  });
});
