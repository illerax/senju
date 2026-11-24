// Viewers in the main process: windows for viewers shown on their own, the
// files viewers read, sent only to the windows that asked, and HTML pages,
// served under `senju-view:` with a policy that runs their scripts but loads
// nothing from the network or the disk.

import path from 'node:path';
import { BrowserWindow, protocol, type WebContents } from 'electron';
import type { ClientMessage, DaemonMessage } from '../shared/protocol';
import { loadSettings, resolveTheme } from '../shared/settings';
import type { AppState } from '../shared/types';
import { viewerFormat, viewerLabel } from '../shared/viewer';

const SCHEME = 'senju-view';
const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/** Before the app is ready: lets pages of the scheme run as pages of their own origin. */
export function registerViewerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

export class ViewerWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  /** Windows waiting for a viewer's file, by viewer id. */
  private readonly reads = new Map<string, Set<WebContents>>();
  /** The last content of each HTML viewer, served to its frame. */
  private readonly pages = new Map<string, string>();
  private state: AppState | null = null;

  constructor(
    private readonly daemon: { send: (msg: ClientMessage) => void },
    private readonly quitting: () => boolean,
  ) {}

  /** After the app is ready. */
  serve(): void {
    protocol.handle(SCHEME, (request) => {
      const page = this.pages.get(new URL(request.url).hostname);
      if (page === undefined) return new Response('Not found', { status: 404 });
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY } });
    });
  }

  /** A window asks for a viewer's file: the answer goes back to it. */
  asked(sender: WebContents, msg: ClientMessage): void {
    if (msg.type !== 'readViewer') return;
    const waiting = this.reads.get(msg.viewerId) ?? new Set();
    waiting.add(sender);
    this.reads.set(msg.viewerId, waiting);
  }

  /** Routes a viewer's file to the windows that asked for it; false for other messages. */
  received(msg: DaemonMessage): boolean {
    if (msg.type !== 'viewer') return false;
    const viewer = this.state?.viewers[msg.viewerId];
    if (viewer && msg.content && !msg.content.error && viewerFormat(viewer.file, viewer.format).kind === 'html') this.pages.set(viewer.id, msg.content.data);
    for (const sender of this.reads.get(msg.viewerId) ?? []) if (!sender.isDestroyed()) sender.send('daemon', msg);
    this.reads.delete(msg.viewerId);
    return true;
  }

  /** Opens a window for each viewer shown on its own, and closes those of viewers that are gone. */
  update(state: AppState): void {
    this.state = state;
    for (const id of this.pages.keys()) if (!state.viewers[id]) this.pages.delete(id);
    for (const [id, win] of this.windows) {
      if (state.viewers[id]?.window) continue;
      this.windows.delete(id);
      win.destroy();
    }
    for (const viewer of Object.values(state.viewers)) {
      if (viewer.window && !this.windows.has(viewer.id)) this.open(viewer.id);
      this.windows.get(viewer.id)?.setTitle(viewerLabel(viewer));
    }
  }

  /** Sends to every viewer window, e.g. settings saved elsewhere. */
  broadcast(channel: string, payload: unknown): void {
    for (const win of this.windows.values()) win.webContents.send(channel, payload);
  }

  private open(viewerId: string): void {
    const viewer = this.state?.viewers[viewerId];
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 320,
      minHeight: 240,
      title: viewer ? viewerLabel(viewer) : 'Senju',
      icon: process.platform === 'darwin' ? undefined : path.join(__dirname, 'icon.png'),
      backgroundColor: resolveTheme(loadSettings()).background,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.windows.set(viewerId, win);
    win.once('ready-to-show', () => win.show());
    void win.loadFile(path.join(__dirname, 'renderer', 'viewer.html'), { query: { viewer: viewerId } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    // Page titles must not replace the viewer's name.
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('close', () => {
      // Closed by the user: the viewer goes; on quit it opens again with the app.
      if (this.windows.get(viewerId) === win && !this.quitting()) this.daemon.send({ type: 'action', action: { type: 'closeViewer', viewerId } });
    });
    win.on('closed', () => {
      if (this.windows.get(viewerId) === win) this.windows.delete(viewerId);
    });
  }
}
