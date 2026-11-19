// Where the daemon runs from. Updating replaces the app's files. On Linux
// packages that does not disturb a running daemon, but the Windows installer
// closes every running Senju.exe, an AppImage's mount goes away when the old
// version quits, and on macOS the replaced bundle would hand a running daemon
// the new version's files (node-pty's spawn-helper, for one). There the
// daemon runs from a copy of the app, kept per version outside the install
// location, so an update never stops the user's terminals.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import { appBundle } from '../shared/update';

export interface DaemonLauncher {
  executable: string;
  script: string;
  env: NodeJS.ProcessEnv;
}

/** Copies kept, newest first; an older daemon may still run from the previous one. */
const KEEP_COPIES = 2;

/**
 * The daemon's environment: the app's own, without what the AppImage runtime
 * adds, which would point the user's shells into a mount that goes away.
 */
function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const appDir = process.env.APPDIR;
  for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'CHROME_DESKTOP']) delete env[key];
  if (appDir) {
    for (const key of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'PERLLIB', 'QT_PLUGIN_PATH']) {
      const value = env[key];
      if (!value) continue;
      const kept = value.split(path.delimiter).filter((part) => part && !part.startsWith(appDir));
      if (kept.length) env[key] = kept.join(path.delimiter);
      else delete env[key];
    }
  }
  return env;
}

export function needsCopy(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin' || (!!process.env.APPIMAGE && !!process.env.APPDIR));
}

async function copyApp(root: string, target: string, executableRelative: string): Promise<void> {
  const partial = `${target}.partial-${process.pid}`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  // Copy app.asar as the file it is, not as the folder Electron's fs shows.
  process.noAsar = true;
  try {
    // Clones where the file system can (APFS), which takes no time or space.
    await fs.promises.cp(root, partial, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  } finally {
    process.noAsar = false;
  }
  if (process.platform === 'win32') {
    // Another name, so the installer's "is Senju running" check does not find it.
    const exe = path.join(partial, executableRelative);
    await fs.promises.rename(exe, path.join(path.dirname(exe), 'senju-daemon.exe'));
  }
  await fs.promises.writeFile(path.join(partial, '.complete'), BUILD_ID);
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.rename(partial, target);
}

async function pruneCopies(current: string): Promise<void> {
  const dir = path.dirname(current);
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const copies = await Promise.all(
    entries.map(async (name) => {
      const full = path.join(dir, name);
      const stat = await fs.promises.stat(full).catch(() => null);
      return { full, time: stat?.mtimeMs ?? 0 };
    }),
  );
  copies.sort((a, b) => b.time - a.time);
  for (const { full } of copies.filter((c) => c.full !== current).slice(KEEP_COPIES - 1)) {
    // A copy still in use cannot be removed on Windows; it goes on a later start.
    await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export async function daemonLauncher(script: string): Promise<DaemonLauncher> {
  const env = daemonEnv();
  if (!needsCopy()) return { executable: process.execPath, script, env };

  // macOS copies the whole bundle, which keeps its .app name so it still is one.
  const bundle = process.platform === 'darwin' ? appBundle(process.execPath) : null;
  const root = process.env.APPIMAGE ? process.env.APPDIR! : (bundle ?? path.dirname(process.execPath));
  const executableRelative = path.relative(root, process.execPath);
  const target = path.join(paths.daemonCopies, `${app.getVersion()}-${BUILD_ID}${bundle ? '.app' : ''}`);
  if (!fs.existsSync(path.join(target, '.complete'))) await copyApp(root, target, executableRelative);
  void pruneCopies(target);
  const executable =
    process.platform === 'win32' ? path.join(target, path.dirname(executableRelative), 'senju-daemon.exe') : path.join(target, executableRelative);
  return { executable, script: path.join(target, path.relative(root, script)), env };
}
