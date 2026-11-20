// Electron main process: one window that renders the daemon's state.
// Closing the window leaves the daemon and all pane processes running.

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron';
import type { ClientMessage, DaemonMessage } from '../shared/protocol';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import { loadSettings, resolveFont, resolveTheme, saveSettings, type Settings } from '../shared/settings';
import type { AppState, UiState } from '../shared/types';
import { DaemonClient, DaemonReplaceDeclined } from './daemon-client';
import { daemonLauncher } from './daemon-runtime';
import { diagnose, diagnoseError, systemInfo, watchEventLoop } from '../shared/diagnostics';
import { Updater } from './updater';
import { clearNotification, notify, setBadge } from './notifications';
import type { UpdateAction } from '../shared/update';

const daemon = new DaemonClient(
  () => daemonLauncher(path.join(__dirname, 'daemon.js')),
  async () => {
    // Before any window exists, so a system dialog is the only way to ask.
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restart service', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      title: 'Senju',
      message: 'This version of Senju needs to restart its background service.',
      detail: 'Running programs stop and come back as after a reboot: layout, folders and scrollback are restored, agents resume their sessions. Quit to keep them running with the version you had.',
    });
    return response === 0;
  },
);
let win: BrowserWindow | null = null;
let lastUi: UiState = {};
let lastState: AppState | null = null;
let resolveFirstState: () => void;
const firstState = new Promise<void>((resolve) => (resolveFirstState = resolve));
let quitting = false;
const updater = new Updater(
  (status) => win?.webContents.send('update', status),
  () => loadSettings().checkForUpdates,
);

function send(msg: DaemonMessage | { type: 'connected'; outdated: boolean }): void {
  win?.webContents.send('daemon', msg);
}

function boundsVisible(b: NonNullable<UiState['bounds']>): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
}

function createWindow(): void {
  const saved = lastUi.bounds;
  const bounds = saved && boundsVisible(saved) ? saved : { width: 1280, height: 800 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 320,
    title: 'Senju',
    // macOS takes the icon from the app bundle.
    icon: process.platform === 'darwin' ? undefined : path.join(__dirname, 'icon.png'),
    backgroundColor: resolveTheme(loadSettings()).background,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (saved?.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let timer: NodeJS.Timeout | null = null;
  const saveBounds = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized() || win.isFullScreen();
      const ui: UiState = { bounds: { ...(maximized && lastUi.bounds ? lastUi.bounds : win.getBounds()), maximized } };
      lastUi = ui;
      daemon.send({ type: 'action', action: { type: 'setUi', ui } });
    }, 300);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(event as 'resize', saveBounds);
  win.on('closed', () => {
    win = null;
  });
  watchWindow(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** A visible window that sent no heartbeat (perf-monitor.ts) for this long is hung. */
const HUNG_MS = 5000;

/** Logs a window that stops responding, even one that never recovers, and why its renderer process ended. */
function watchWindow(window: BrowserWindow): void {
  let alive = Date.now();
  let visible = true;
  let hungSince = 0;
  const onAlive = (e: Electron.IpcMainEvent, isVisible: boolean) => {
    if (e.sender !== window.webContents) return;
    if (hungSince) diagnose('main', 'window responding again', { afterMs: Date.now() - hungSince });
    alive = Date.now();
    visible = isVisible;
    hungSince = 0;
  };
  ipcMain.on('alive', onAlive);
  let tick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // A late tick means this process stood still too (the system slept, say), not the window.
    if (now - tick > 3000) alive = now;
    tick = now;
    if (hungSince || !visible || now - alive < HUNG_MS) return;
    hungSince = alive;
    diagnose('main', 'window not responding', { silentMs: now - alive });
  }, 1000);
  window.on('closed', () => {
    clearInterval(timer);
    ipcMain.off('alive', onAlive);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') diagnose('main', 'window process gone', { ...details });
  });
  window.webContents.on('preload-error', (_e, _path, error) => diagnoseError('main', 'preload error', error));
}

/** The start entry of the main process: the app, the system and what draws the window. */
async function diagnoseStart(): Promise<void> {
  const gpu = (await app.getGPUInfo('basic').catch(() => null)) as { gpuDevice?: { vendorId: number; deviceId: number; active?: boolean; driverVendor?: string; driverVersion?: string }[] } | null;
  const settings = loadSettings();
  diagnose('main', 'start', {
    version: app.getVersion(),
    build: BUILD_ID,
    ...systemInfo(),
    chrome: process.versions.chrome,
    installed: process.env.APPIMAGE ? 'AppImage' : app.isPackaged ? 'package' : 'source',
    session: process.platform === 'linux' ? `${process.env.XDG_SESSION_TYPE ?? '?'} ${process.env.XDG_CURRENT_DESKTOP ?? '?'}` : undefined,
    displays: screen.getAllDisplays().map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}`),
    gpu: gpu?.gpuDevice?.map((d) => ({ vendor: d.vendorId.toString(16), device: d.deviceId.toString(16), active: d.active, driver: [d.driverVendor, d.driverVersion].filter(Boolean).join(' ') || undefined })),
    gpuFeatures: app.getGPUFeatureStatus(),
    settings: { theme: settings.theme, ...resolveFont(settings), zoom: settings.zoom, scrollback: settings.scrollback, persistedScrollback: settings.persistedScrollback },
  });
}

function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an application menu; terminal shortcuts are handled by the renderer.
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit and Stop All Processes', click: () => void stopAll() },
        { role: 'quit' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function stopAll(): Promise<void> {
  quitting = true;
  await daemon.stopDaemon();
  app.quit();
}

function ensureSettingsFile(): void {
  if (fs.existsSync(paths.settingsFile)) return;
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.settingsFile, '{}\n');
}

function registerIpc(): void {
  ipcMain.on('daemon', (_e, msg: ClientMessage) => daemon.send(msg));
  ipcMain.handle('settings', () => loadSettings());
  ipcMain.handle('saveSettings', (_e, patch: Partial<Settings>) => saveSettings(patch));
  ipcMain.handle('state', () => lastState);
  ipcMain.handle('platform', () => process.platform);
  ipcMain.handle('homedir', () => app.getPath('home'));
  ipcMain.handle('pickFolder', async (_e, defaultPath?: string) => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath });
    return result.canceled ? null : result.filePaths[0];
  });
  // Groups saved to a file the user picks (closed-groups.ts in the daemon reads and writes them).
  const groupFilters = [{ name: 'Senju group', extensions: ['senju'] }];
  ipcMain.handle('saveGroupFile', async (_e, name: string) => {
    if (!win) return null;
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '').trim() || 'group';
    const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `${safe}.senju`), filters: groupFilters });
    return result.canceled || !result.filePath ? null : result.filePath;
  });
  ipcMain.handle('openGroupFile', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: groupFilters });
    return result.canceled ? null : result.filePaths[0];
  });
  // The selection clipboard (X11/Wayland primary selection) exists only on Linux.
  const board = (type: 'clipboard' | 'selection') => (type === 'selection' ? clipboard.selection : clipboard);
  ipcMain.handle('clipboardRead', (_e, type: 'clipboard' | 'selection') => board(type)?.readText() ?? '');
  ipcMain.on('clipboardWrite', (_e, text: string, type: 'clipboard' | 'selection') => void board(type)?.writeText(text));
  ipcMain.on('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on('openConfig', (_e, what: 'settings' | 'recipes' | 'logs') => {
    if (what === 'logs') {
      if (fs.existsSync(paths.diagnosticsFile)) shell.showItemInFolder(paths.diagnosticsFile);
      else void shell.openPath(path.dirname(paths.diagnosticsFile));
    } else if (what === 'settings') {
      ensureSettingsFile();
      void shell.openPath(paths.settingsFile);
    } else {
      fs.mkdirSync(paths.recipesDir, { recursive: true });
      void shell.openPath(paths.recipesDir);
    }
  });
  ipcMain.on('stopAll', () => void stopAll());
  ipcMain.handle('daemonOutdated', () => daemon.outdated);
  ipcMain.handle('appInfo', () => ({
    version: app.getVersion(),
    build: BUILD_ID,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    daemonOutdated: daemon.outdated,
  }));
  ipcMain.on('restartDaemon', () => daemon.restartDaemon());
  ipcMain.on('diagnose', (_e, event: string, details: Record<string, unknown>) => diagnose('window', String(event), details));
  ipcMain.on('diagnoseError', (_e, event: string, error: { heapMB?: number }) => diagnoseError('window', String(event), error, { heapMB: error?.heapMB }));
  ipcMain.on('notify', (_e, terminalId: string, title: string, body: string) => notify(win, String(terminalId), String(title), String(body)));
  ipcMain.on('clearNotification', (_e, terminalId: string) => clearNotification(String(terminalId)));
  ipcMain.on('setBadge', (_e, count: number) => setBadge(win, Number(count) || 0));
  ipcMain.handle('updateStatus', () => updater.current);
  ipcMain.on('updateAction', (_e, action: UpdateAction) => {
    if (action === 'check') void updater.check();
    if (action === 'download') void updater.download();
    if (action === 'install') {
      updater.install(() => {
        // Leave the daemon running: the new version reconnects to it.
        quitting = true;
        daemon.close();
      });
    }
    if (action === 'dismiss') updater.dismiss();
  });
}

process.on('uncaughtExceptionMonitor', (err) => diagnoseError('main', 'uncaught exception', err));
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection', err);
  diagnoseError('main', 'unhandled rejection', err);
});

// An isolated home (used by tests) gets its own browser profile and single-instance lock.
if (process.env.SENJU_HOME) app.setPath('userData', path.join(process.env.SENJU_HOME, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });

  daemon.on('message', (msg) => {
    if (msg.type === 'state') {
      lastState = msg.state;
      lastUi = msg.state.ui;
      resolveFirstState();
    }
    send(msg);
  });
  daemon.on('connected', () => send({ type: 'connected', outdated: daemon.outdated }));
  daemon.on('declined', () => app.quit());

  void app.whenReady().then(async () => {
    watchEventLoop('main', 200);
    void diagnoseStart();
    app.on('child-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') diagnose('main', 'process gone', { ...details });
    });
    buildMenu();
    registerIpc();
    try {
      await daemon.connect();
    } catch (err) {
      if (err instanceof DaemonReplaceDeclined) {
        app.quit();
        return;
      }
      dialog.showErrorBox('Senju', `Could not connect to the Senju daemon.\n\n${String(err)}`);
      app.quit();
      return;
    }
    // Wait for the first state so the window opens with its saved bounds.
    await firstState;
    createWindow();
    updater.start();
  });

  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || quitting) app.quit();
  });
  app.on('will-quit', () => daemon.close());
}
