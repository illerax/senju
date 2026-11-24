import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateAction, UpdateStatus } from '../shared/update';


const api = {
  send: (msg: unknown) => ipcRenderer.send('daemon', msg),
  onMessage: (callback: (msg: unknown) => void) => {
    ipcRenderer.on('daemon', (_e, msg) => callback(msg));
  },
  state: () => ipcRenderer.invoke('state'),
  settings: () => ipcRenderer.invoke('settings'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('saveSettings', patch),
  platform: () => ipcRenderer.invoke('platform') as Promise<string>,
  homedir: () => ipcRenderer.invoke('homedir') as Promise<string>,
  saveGroupFile: (name: string) => ipcRenderer.invoke('saveGroupFile', name) as Promise<string | null>,
  openGroupFile: () => ipcRenderer.invoke('openGroupFile') as Promise<string | null>,
  pickFolder: (defaultPath?: string) => ipcRenderer.invoke('pickFolder', defaultPath) as Promise<string | null>,
  pickFile: (defaultPath?: string) => ipcRenderer.invoke('pickFile', defaultPath) as Promise<string | null>,
  clipboardRead: (type: 'clipboard' | 'selection' = 'clipboard') => ipcRenderer.invoke('clipboardRead', type) as Promise<string>,
  clipboardWrite: (text: string, type: 'clipboard' | 'selection' = 'clipboard') => ipcRenderer.send('clipboardWrite', text, type),
  openExternal: (url: string) => ipcRenderer.send('openExternal', url),
  openConfig: (what: 'settings' | 'recipes' | 'logs') => ipcRenderer.send('openConfig', what),
  stopAll: () => ipcRenderer.send('stopAll'),
  /** Closes this window; a page may not close a window it did not open. */
  closeWindow: () => ipcRenderer.send('closeWindow'),
  /** Opens a new window, empty or showing a group moved from this one. */
  newWindow: (groupId?: string) => ipcRenderer.send('newWindow', groupId),
  daemonOutdated: () => ipcRenderer.invoke('daemonOutdated') as Promise<boolean>,
  appInfo: () =>
    ipcRenderer.invoke('appInfo') as Promise<{ version: string; build: string; electron: string; chrome: string; node: string; platform: string; daemonOutdated: boolean }>,
  restartDaemon: () => ipcRenderer.send('restartDaemon'),
  diagnose: (event: string, details: Record<string, unknown>) => ipcRenderer.send('diagnose', event, details),
  alive: (visible: boolean) => ipcRenderer.send('alive', visible),
  diagnoseError: (event: string, error: { name: string; message: string; stack?: string; heapMB?: number }) => ipcRenderer.send('diagnoseError', event, error),
  updateStatus: () => ipcRenderer.invoke('updateStatus') as Promise<UpdateStatus>,
  updateAction: (action: UpdateAction) => ipcRenderer.send('updateAction', action),
  notify: (terminalId: string, title: string, body: string) => ipcRenderer.send('notify', terminalId, title, body),
  clearNotification: (terminalId: string) => ipcRenderer.send('clearNotification', terminalId),
  setBadge: (count: number) => ipcRenderer.send('setBadge', count),
  onNotificationClick: (callback: (terminalId: string) => void) => {
    ipcRenderer.on('notificationClick', (_e, terminalId) => callback(terminalId));
  },
  /** Settings saved in another window. */
  onSettings: (callback: (settings: unknown) => void) => {
    ipcRenderer.on('settings', (_e, settings) => callback(settings));
  },
  onUpdate: (callback: (status: UpdateStatus) => void) => {
    ipcRenderer.on('update', (_e, status) => callback(status));
  },
};

export type SenjuApi = typeof api;

contextBridge.exposeInMainWorld('senju', api);
