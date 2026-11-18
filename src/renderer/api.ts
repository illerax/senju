import type { SenjuApi } from '../preload/preload';
import type { ClientMessage } from '../shared/protocol';
import type { Settings } from '../shared/settings';

type Api = Omit<SenjuApi, 'send' | 'settings' | 'saveSettings'> & {
  send: (msg: ClientMessage) => void;
  settings: () => Promise<Settings>;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
};

export const senju = (window as unknown as { senju: Api }).senju;
