// A window of its own for one viewer (src/main/viewer-windows.ts): the viewer
// fills it, and closing the window closes the viewer.

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import type { Action, DaemonMessage } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { clampZoom, resolveTheme } from '../shared/themes';
import type { AppState } from '../shared/types';
import { senju } from './api';
import { showMenu } from './menu';
import { applyTheme } from './theme';
import { ViewerView } from './viewer-view';

const viewerId = new URLSearchParams(location.search).get('viewer') ?? '';
let settings: Settings;
let home = '';
let zoom = 0;
let zoomTimer: ReturnType<typeof setTimeout> | null = null;

const act = (action: Action) => senju.send({ type: 'action', action });

const view = new ViewerView(viewerId, {
  read: (id, known) => senju.send({ type: 'readViewer', viewerId: id, known }),
  openLink: (url) => senju.openExternal(url),
  copy: (text) => senju.clipboardWrite(text),
  menu: (items, e) => showMenu(items, { x: e.clientX, y: e.clientY }),
  onZoom: (_id, steps) => setZoom(zoom + steps),
  home: () => home,
});

/** Zooms the viewer; sent to the daemon once the zooming pauses. */
function setZoom(next: number): void {
  zoom = clampZoom(settings, settings.zoom + next) - settings.zoom;
  view.setZoom(settings.zoom + zoom);
  if (zoomTimer) clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => act({ type: 'zoomTab', terminalId: viewerId, zoom }), 300);
}

function onState(state: AppState): void {
  const viewer = state.viewers?.[viewerId];
  if (!viewer) return;
  if (!zoomTimer) zoom = viewer.zoom ?? 0;
  view.setZoom(settings.zoom + zoom);
  view.update(viewer);
}

async function main(): Promise<void> {
  [settings, home] = await Promise.all([senju.settings(), senju.homedir()]);
  applyTheme(resolveTheme(settings));
  document.body.append(view.element);
  view.attach();
  senju.onMessage((raw) => {
    const msg = raw as DaemonMessage | { type: 'connected' };
    if (msg.type === 'state') onState(msg.state);
    if (msg.type === 'viewer' && msg.viewerId === viewerId) view.setContent(msg.content);
    if (msg.type === 'connected') view.reset();
  });
  senju.onSettings((next) => {
    settings = next as Settings;
    applyTheme(resolveTheme(settings));
    view.setZoom(settings.zoom + zoom);
  });
  window.addEventListener('keydown', (e) => {
    // The usual keys to close a window, as it has no menu.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      senju.closeWindow();
    }
  });
  const initial = (await senju.state()) as AppState | null;
  if (initial) onState(initial);
  view.focus();
}

void main();
