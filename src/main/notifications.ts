// System notifications about agents that need the user, and the count of
// them on the app icon and the taskbar.

import { app, BrowserWindow, Notification } from 'electron';

const shown = new Map<string, Notification>();

/** Shows a notification for a terminal, replacing its earlier one; a click brings the window to that terminal. */
export function notify(win: BrowserWindow | null, terminalId: string, title: string, body: string): void {
  if (!win || win.isDestroyed() || !Notification.isSupported()) return;
  shown.get(terminalId)?.close();
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('notificationClick', terminalId);
  });
  notification.on('close', () => {
    if (shown.get(terminalId) === notification) shown.delete(terminalId);
  });
  shown.set(terminalId, notification);
  notification.show();
  // Windows and Linux taskbars highlight the window until it is focused.
  if (!win.isFocused()) win.flashFrame(true);
}

/** The user has seen the terminal: its notification is no longer news. */
export function clearNotification(terminalId: string): void {
  shown.get(terminalId)?.close();
  shown.delete(terminalId);
}

/** The number of agents that need the user, on the dock icon (macOS) or the launcher entry (Linux, where supported). */
export function setBadge(win: BrowserWindow | null, count: number): void {
  app.setBadgeCount(count);
  if (count === 0 && win && !win.isDestroyed()) win.flashFrame(false);
}
