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
  pickFolder: (defaultPath?: string) => ipcRenderer.invoke('pickFolder', defaultPath) as Promise<string | null>,
  clipboardRead: (type: 'clipboard' | 'selection' = 'clipboard') => ipcRenderer.invoke('clipboardRead', type) as Promise<string>,
  clipboardWrite: (text: string, type: 'clipboard' | 'selection' = 'clipboard') => ipcRenderer.send('clipboardWrite', text, type),
  openExternal: (url: string) => ipcRenderer.send('openExternal', url),
  openConfig: (what: 'settings' | 'recipes') => ipcRenderer.send('openConfig', what),
  stopAll: () => ipcRenderer.send('stopAll'),
  daemonOutdated: () => ipcRenderer.invoke('daemonOutdated') as Promise<boolean>,
  appInfo: () =>
    ipcRenderer.invoke('appInfo') as Promise<{ version: string; build: string; electron: string; chrome: string; node: string; platform: string; daemonOutdated: boolean }>,
  restartDaemon: () => ipcRenderer.send('restartDaemon'),
  updateStatus: () => ipcRenderer.invoke('updateStatus') as Promise<UpdateStatus>,
  updateAction: (action: UpdateAction) => ipcRenderer.send('updateAction', action),
  onUpdate: (callback: (status: UpdateStatus) => void) => {
    ipcRenderer.on('update', (_e, status) => callback(status));
  },
};

export type SenjuApi = typeof api;

contextBridge.exposeInMainWorld('senju', api);
