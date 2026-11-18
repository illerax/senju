// Checks GitHub releases for a newer version and, with the user's approval,
// downloads and installs it. Installing replaces only the app: settings and
// state live in the user's folders, and the daemon keeps the terminals
// running (see daemon-runtime.ts), so an update never interrupts work.

import { app, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../shared/update';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const RELEASES = 'https://github.com/illerax/senju/releases';

export class Updater {
  private status: UpdateStatus = { state: 'idle' };
  /** A version the user said "Later" to; it is not offered again until a newer one appears. */
  private dismissed: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onStatus: (status: UpdateStatus) => void,
    private readonly enabled: () => boolean,
  ) {}

  /** Self-updating needs a signed app on macOS; unsigned builds point to the release page instead. */
  private get manual(): boolean {
    return process.platform === 'darwin';
  }

  private get supported(): boolean {
    return app.isPackaged || !!process.env.SENJU_UPDATE_URL;
  }

  start(): void {
    if (!this.supported) {
      this.set({ state: 'unsupported', reason: 'Updates are checked in installed builds; this one runs from source.' });
      return;
    }
    if (process.env.SENJU_UPDATE_URL) {
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
      this.set({ state: 'available', version: info.version, url: `${RELEASES}/tag/v${info.version}`, manual: this.manual });
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      if (this.status.state === 'downloading' || this.status.state === 'available') {
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

  private set(status: UpdateStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  async check(): Promise<void> {
    if (!this.supported) return;
    // Do not interrupt a download or a ready update.
    if (this.status.state === 'downloading' || this.status.state === 'ready') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ state: 'error', message: String((err as Error).message ?? err).split('\n')[0] });
    }
  }

  /** The user approved: download the update, or open its release page where the app cannot update itself. */
  async download(): Promise<void> {
    if (this.status.state !== 'available') return;
    if (this.status.manual) {
      void shell.openExternal(this.status.url);
      return;
    }
    this.set({ state: 'downloading', version: this.status.version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.set({ state: 'error', message: String((err as Error).message ?? err).split('\n')[0] });
    }
  }

  /** Quits, installs and starts the new version. Terminals keep running in the daemon. */
  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(false, true);
  }

  dismiss(): void {
    if (this.status.state === 'available') this.dismissed = this.status.version;
    this.set({ state: 'current', checkedAt: Date.now() });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
