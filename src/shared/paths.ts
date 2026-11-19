// File system locations. Kept free of Electron APIs so the daemon can use them.

import os from 'node:os';
import path from 'node:path';

function baseDirs(): { config: string; state: string; runtime: string } {
  const home = os.homedir();
  if (process.env.SENJU_HOME) {
    const root = process.env.SENJU_HOME;
    return { config: root, state: root, runtime: root };
  }
  if (process.platform === 'darwin') {
    const dir = path.join(home, 'Library', 'Application Support', 'Senju');
    return { config: dir, state: dir, runtime: dir };
  }
  if (process.platform === 'win32') {
    const dir = path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Senju');
    return { config: dir, state: dir, runtime: dir };
  }
  const config = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'senju');
  const state = path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'senju');
  const runtime = process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'senju') : state;
  return { config, state, runtime };
}

export const paths = {
  get configDir() {
    return baseDirs().config;
  },
  get settingsFile() {
    return path.join(baseDirs().config, 'settings.json');
  },
  get recipesDir() {
    return path.join(baseDirs().config, 'recipes');
  },
  get stateFile() {
    return path.join(baseDirs().state, 'state.json');
  },
  get logFile() {
    return path.join(baseDirs().state, 'daemon.log');
  },
  /** Slow moments and errors of the daemon, the main process and the window, with the system they ran on (diagnostics.ts). */
  get diagnosticsFile() {
    return path.join(baseDirs().state, 'diagnostics.log');
  },
  get runtimeDir() {
    return baseDirs().runtime;
  },
  /** Copies of the app the daemon runs from where installers would stop it otherwise. */
  get daemonCopies() {
    if (process.env.SENJU_HOME) return path.join(process.env.SENJU_HOME, 'daemon-runtime');
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? baseDirs().state, 'Senju', 'daemon-runtime');
    const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(process.platform === 'linux' ? path.join(data, 'senju') : baseDirs().state, 'daemon-runtime');
  },
  get socket() {
    if (process.platform === 'win32') {
      const user = (process.env.USERNAME ?? 'user').replace(/[^\w-]/g, '_');
      const suffix = process.env.SENJU_HOME ? `-${Buffer.from(process.env.SENJU_HOME).toString('hex').slice(-16)}` : '';
      return `\\\\.\\pipe\\senju-${user}${suffix}`;
    }
    return path.join(baseDirs().runtime, 'daemon.sock');
  },
};
