// Self-update on macOS without code signing. electron-updater installs through
// Squirrel.Mac, which only accepts an update signed like the running app, and
// Senju is not signed. This does what install.sh does instead: download the
// disk image, copy the app out of it next to the installed one, and swap the
// two by renaming, so the installed app is never half written. The daemon runs
// from its own copy of the app (daemon-runtime.ts) and is not touched.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, net } from 'electron';
import { appBundle } from '../shared/update';

const run = promisify(execFile);

export interface MacInstall {
  /** The installed bundle, e.g. /Applications/Senju.app. */
  bundle: string;
  /** Where the new version waits until it replaces the bundle. */
  staged: string;
  /** Where the old version goes while it is replaced; removed afterwards. */
  old: string;
}

export function macInstall(): MacInstall | null {
  const bundle = appBundle(process.execPath);
  if (!bundle) return null;
  const dir = path.dirname(bundle);
  const name = path.basename(bundle);
  return { bundle, staged: path.join(dir, `.${name}.update`), old: path.join(dir, `.${name}.old`) };
}

/** Why the app cannot replace itself, or null when it can. */
export function installBlocker(install: MacInstall | null): string | null {
  if (!install) return 'Senju does not run from an app bundle.';
  // Gatekeeper runs apps opened from where they were downloaded from a random read-only path.
  if (install.bundle.includes('/AppTranslocation/')) return 'macOS runs Senju from a temporary copy; move Senju.app to Applications.';
  try {
    fs.accessSync(path.dirname(install.bundle), fs.constants.W_OK);
  } catch {
    return `Senju cannot write to ${path.dirname(install.bundle)}.`;
  }
  return null;
}

/** Removes what an interrupted update left behind. */
export function removeLeftovers(install: MacInstall | null): void {
  if (!install) return;
  for (const dir of [install.staged, install.old]) void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Downloads a file, reporting progress in percent. Gives up when no data
 * arrived for `stallMs`, as a request on a dead connection never ends.
 */
export async function download(url: string, file: string, stallMs: number, onProgress: (percent: number) => void): Promise<void> {
  const abort = new AbortController();
  let stalled = false;
  const stall = setTimeout(() => {
    stalled = true;
    abort.abort();
  }, stallMs);
  const partial = `${file}.partial`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(partial);
  try {
    const response = await net.fetch(url, { signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`The update server answered ${response.status} ${response.statusText}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stall.refresh();
      received += value.length;
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      if (total) onProgress(Math.min(100, Math.round((received / total) * 100)));
    }
    if (total && received !== total) throw new Error('The download was cut short');
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    await fs.promises.rename(partial, file);
  } catch (err) {
    out.destroy();
    await fs.promises.rm(partial, { force: true });
    throw stalled ? new Error('The download stopped: no data from the update server') : err;
  } finally {
    clearTimeout(stall);
  }
}

/** Copies the app out of the disk image to the staging place and checks that it is the expected version. */
export async function stage(diskImage: string, install: MacInstall, version: string): Promise<void> {
  const mount = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'senju-update-'));
  await fs.promises.rm(install.staged, { recursive: true, force: true });
  await run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, diskImage], { timeout: 120_000 });
  try {
    const name = (await fs.promises.readdir(mount)).find((entry) => entry.endsWith('.app'));
    if (!name) throw new Error('The disk image holds no app');
    await run('ditto', [path.join(mount, name), install.staged], { timeout: 300_000 });
  } finally {
    await run('hdiutil', ['detach', '-force', mount], { timeout: 60_000 }).catch(() => {});
    await fs.promises.rm(mount, { recursive: true, force: true }).catch(() => {});
  }
  // Downloads by the app itself are not quarantined, but clear it as install.sh does.
  await run('xattr', ['-dr', 'com.apple.quarantine', install.staged]).catch(() => {});
  const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(install.staged, 'Contents', 'Info.plist')]);
  if (stdout.trim() !== version) {
    await fs.promises.rm(install.staged, { recursive: true, force: true });
    throw new Error(`The downloaded app is version ${stdout.trim()}, not ${version}`);
  }
}

/** Puts the staged version in place of the installed one; synchronous, so it can run while the app quits. */
export function swap(install: MacInstall): void {
  fs.rmSync(install.old, { recursive: true, force: true });
  fs.renameSync(install.bundle, install.old);
  try {
    fs.renameSync(install.staged, install.bundle);
  } catch (err) {
    fs.renameSync(install.old, install.bundle);
    throw err;
  }
  // Files of a running program stay readable after removal, so the old version can go now.
  void fs.promises.rm(install.old, { recursive: true, force: true }).catch(() => {});
}
