// Checks GitHub releases for a newer version and, with the user's approval,
// downloads and installs it. Installing replaces only the app: settings and
// state live in the user's folders, and the daemon keeps the terminals
// running (see daemon-runtime.ts), so an update never interrupts work.
// Linux and Windows update through electron-updater, macOS through
// mac-update.ts, as electron-updater needs a signed app there.

import fs from 'node:fs';
import path from 'node:path';
import { app, net, shell } from 'electron';
import { CancellationToken } from 'builder-util-runtime';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { isNewerVersion, macDiskImage, type ReleaseInfo, type UpdateStatus } from '../shared/update';
import * as mac from './mac-update';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/**
 * How long a check may wait for an answer and a download for more data. On a
 * connection that went dead without closing, requests through Electron's net
 * never time out on their own, and electron-updater would hand every later
 * check the hung one. Tests shorten it.
 */
const STALL_MS = Number(process.env.SENJU_UPDATE_STALL_MS) || 60_000;
const RELEASES = 'https://github.com/illerax/senju/releases';
const LATEST_RELEASE_API = 'https://api.github.com/repos/illerax/senju/releases/latest';

export class Updater {
  private status: UpdateStatus = { state: 'idle' };
  /** A version the user said "Later" to; it is not offered again until a newer one appears. */
  private dismissed: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Cancels the download when no data arrived for STALL_MS. */
  private stallTimer: NodeJS.Timeout | null = null;
  /** macOS: the installed bundle and its staging places. */
  private readonly macInstall = process.platform === 'darwin' ? mac.macInstall() : null;
  /** macOS: the disk image of the offered version, when this app can install it itself. */
  private macImage: string | null = null;
  private macStaged = false;

  constructor(
    private readonly onStatus: (status: UpdateStatus) => void,
    private readonly enabled: () => boolean,
  ) {}

  private get isMac(): boolean {
    return process.platform === 'darwin';
  }

  /** On macOS the app replaces itself only where it can; otherwise the release page opens. */
  private get manual(): boolean {
    return this.isMac && (!this.macImage || mac.installBlocker(this.macInstall) !== null);
  }

  private get supported(): boolean {
    return app.isPackaged || !!process.env.SENJU_UPDATE_URL;
  }

  start(): void {
    if (!this.supported) {
      this.set({ state: 'unsupported', reason: 'Updates are checked in installed builds; this one runs from source.' });
      return;
    }
    if (this.isMac) {
      mac.removeLeftovers(this.macInstall);
      // Once the user approved the download, finish the install when they quit if they did not restart.
      app.on('will-quit', () => this.installMac(false));
    } else if (process.env.SENJU_UPDATE_URL) {
      // For testing against a local server instead of GitHub.
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SENJU_UPDATE_URL });
      autoUpdater.forceDevUpdateConfig = !app.isPackaged;
    }
    autoUpdater.autoDownload = false;
    // Once the user approved the download, finish the install when they quit if they did not restart.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      if (this.dismissed === info.version) {
        this.set({ state: 'current', checkedAt: Date.now() });
        return;
      }
      this.offer(info.version);
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      if (this.status.state === 'downloading' || this.status.state === 'available') {
        this.stallTimer?.refresh();
        this.set({ state: 'downloading', version: this.status.version, percent: Math.round(progress.percent) });
      }
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.set({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err: Error) => this.set({ state: 'error', message: err.message.split('\n')[0] }));

    this.timer = setTimeout(() => this.scheduled(), FIRST_CHECK_MS);
  }

  private scheduled(): void {
    if (this.enabled()) void this.check();
    this.timer = setTimeout(() => this.scheduled(), CHECK_EVERY_MS);
  }

  get current(): UpdateStatus {
    return this.status;
  }

  private offer(version: string): void {
    this.set({ state: 'available', version, url: `${RELEASES}/tag/v${version}`, manual: this.manual });
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  async check(): Promise<void> {
    if (!this.supported) return;
    // Do not interrupt a download or a ready update.
    if (this.status.state === 'downloading' || this.status.state === 'ready') return;
    try {
      if (this.isMac) await this.checkRelease();
      else await this.withinStall(autoUpdater.checkForUpdates());
    } catch (err) {
      this.set({ state: 'error', message: String((err as Error).message ?? err).split('\n')[0] });
    }
  }

  /**
   * macOS reads the latest release from the GitHub API: electron-updater would
   * need update metadata (latest-mac.yml) that only signed builds can use.
   * Tests serve the same JSON at SENJU_UPDATE_URL/release.json.
   */
  private async checkRelease(): Promise<void> {
    this.set({ state: 'checking' });
    const url = process.env.SENJU_UPDATE_URL ? `${process.env.SENJU_UPDATE_URL}/release.json` : LATEST_RELEASE_API;
    const response = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(STALL_MS) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
    const release = (await response.json()) as ReleaseInfo;
    const version = release.tag_name?.replace(/^v/, '');
    if (!version) throw new Error('The latest release has no version tag');
    if (isNewerVersion(version, app.getVersion()) && this.dismissed !== version) {
      this.macImage = macDiskImage(release, version, process.arch);
      this.offer(version);
    } else {
      this.set({ state: 'current', checkedAt: Date.now() });
    }
  }

  /** macOS: downloads the disk image and copies the new app next to the installed one. */
  private async downloadMac(version: string, image: string, install: mac.MacInstall): Promise<void> {
    this.set({ state: 'downloading', version, percent: 0 });
    try {
      const file = path.join(app.getPath('temp'), `senju-update-${process.pid}`, path.basename(new URL(image).pathname));
      await mac.download(image, file, STALL_MS, (percent) => {
        if (this.status.state === 'downloading') this.set({ state: 'downloading', version, percent });
      });
      await mac.stage(file, install, version);
      await fs.promises.rm(path.dirname(file), { recursive: true, force: true });
      this.macStaged = true;
      this.set({ state: 'ready', version });
    } catch (err) {
      this.set({ state: 'error', message: String((err as Error).message ?? err).split('\n')[0] });
    }
  }

  /** macOS: replaces the installed app with the staged one, and starts it when `relaunch` is set. */
  private installMac(relaunch: boolean): boolean {
    if (!this.macStaged || !this.macInstall) return false;
    this.macStaged = false;
    try {
      mac.swap(this.macInstall);
    } catch (err) {
      this.set({ state: 'error', message: `The update could not be installed: ${(err as Error).message}` });
      return false;
    }
    if (relaunch) app.relaunch();
    return true;
  }

  /** The user approved: download the update, or open its release page where the app cannot update itself. */
  async download(): Promise<void> {
    if (this.status.state !== 'available') return;
    if (this.status.manual) {
      void shell.openExternal(this.status.url);
      return;
    }
    if (this.isMac) {
      if (this.macImage && this.macInstall) await this.downloadMac(this.status.version, this.macImage, this.macInstall);
      return;
    }
    this.set({ state: 'downloading', version: this.status.version, percent: 0 });
    const cancel = new CancellationToken();
    let stalled = false;
    this.stallTimer = setTimeout(() => {
      stalled = true;
      cancel.cancel();
    }, STALL_MS);
    try {
      await autoUpdater.downloadUpdate(cancel);
    } catch (err) {
      const message = stalled ? 'The download stopped: no data from the update server' : String((err as Error).message ?? err).split('\n')[0];
      this.set({ state: 'error', message });
    } finally {
      if (this.stallTimer) clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Gives up on a check that got no answer. electron-updater keeps the pending
   * check and returns it to every later call, so it is dropped to let the next
   * check start over.
   */
  private async withinStall<T>(check: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        (autoUpdater as unknown as { checkForUpdatesPromise: unknown }).checkForUpdatesPromise = null;
        reject(new Error('No answer from the update server'));
      }, STALL_MS);
    });
    try {
      return await Promise.race([check, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Quits, installs and starts the new version; `beforeQuit` runs once the
   * install goes ahead. Terminals keep running in the daemon.
   */
  install(beforeQuit: () => void): void {
    if (this.status.state !== 'ready') return;
    if (this.isMac) {
      if (!this.installMac(true)) return;
      beforeQuit();
      app.quit();
      return;
    }
    beforeQuit();
    autoUpdater.quitAndInstall(false, true);
  }

  dismiss(): void {
    if (this.status.state === 'available') this.dismissed = this.status.version;
    this.set({ state: 'current', checkedAt: Date.now() });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
  }
}
