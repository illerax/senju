/** What the updater is doing, shown in the banner and in Settings → About. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unsupported'; reason: string }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  /** `manual`: the app cannot install it itself and opens `url` instead. */
  | { state: 'available'; version: string; url: string; manual: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'check' | 'download' | 'install' | 'dismiss';
