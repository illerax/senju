// Electron main process: one window that renders the daemon's state.
// Closing the window leaves the daemon and all pane processes running.

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron';
import type { ClientMessage, DaemonMessage } from '../shared/protocol';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import { loadSettings, resolveTheme, saveSettings, type Settings } from '../shared/settings';
import type { AppState, UiState } from '../shared/types';
import { DaemonClient } from './daemon-client';

const daemon = new DaemonClient(path.join(__dirname, 'daemon.js'));
let win: BrowserWindow | null = null;
let lastUi: UiState = {};
let lastState: AppState | null = null;
let resolveFirstState: () => void;
const firstState = new Promise<void>((resolve) => (resolveFirstState = resolve));
let quitting = false;

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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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
  // The selection clipboard (X11/Wayland primary selection) exists only on Linux.
  const board = (type: 'clipboard' | 'selection') => (type === 'selection' ? clipboard.selection : clipboard);
  ipcMain.handle('clipboardRead', (_e, type: 'clipboard' | 'selection') => board(type)?.readText() ?? '');
  ipcMain.on('clipboardWrite', (_e, text: string, type: 'clipboard' | 'selection') => void board(type)?.writeText(text));
  ipcMain.on('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on('openConfig', (_e, what: 'settings' | 'recipes') => {
    if (what === 'settings') {
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
}

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

  void app.whenReady().then(async () => {
    buildMenu();
    registerIpc();
    try {
      await daemon.connect();
    } catch (err) {
      dialog.showErrorBox('Senju', `Could not connect to the Senju daemon.\n\n${String(err)}`);
      app.quit();
      return;
    }
    // Wait for the first state so the window opens with its saved bounds.
    await firstState;
    createWindow();
  });

  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || quitting) app.quit();
  });
  app.on('will-quit', () => daemon.close());
}
