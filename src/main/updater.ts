import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Logger } from '../core/services/context';
import type { UpdateStatus } from '../shared/types';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/*
 * Automatic updates from the public GitHub Releases of the project (electron-updater).
 * - Only the installed Windows app updates itself; the portable .exe and development builds do not.
 * - The request to GitHub carries no personal or financial data (only the app version and platform).
 * - The download is verified against the SHA-512 published with the release before it is installed.
 * - Data lives outside the program folder, so an update never touches it (and a backup is made before migrations).
 */
export class Updater {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private wired = false;

  constructor(private readonly log: Logger, private readonly emit: (s: UpdateStatus) => void, private readonly enabled: () => boolean) {
    this.status = { state: this.supported ? 'idle' : 'unsupported', currentVersion: app.getVersion(), version: null, percent: null, message: null };
  }

  get supported(): boolean {
    return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit(this.status);
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: null }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: null, percent: null }));
    autoUpdater.on('update-available', (info) => {
      this.log.info('update.available', { version: info.version });
      this.set({ state: 'downloading', version: info.version, percent: 0 });
    });
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.log.info('update.downloaded', { version: info.version });
      this.set({ state: 'ready', version: info.version, percent: 100 });
    });
    autoUpdater.on('error', (err) => {
      this.log.warn('update.failed', { message: String(err?.message ?? err).slice(0, 200) });
      this.set({ state: 'error', message: 'No se pudo comprobar o descargar la actualización. Se reintentará más tarde.' });
    });
  }

  /** Called at startup and when the setting changes. */
  start(): void {
    if (!this.supported || !this.enabled()) return;
    this.wire();
    void this.check();
    this.timer ??= setInterval(() => {
      if (this.enabled() && this.status.state !== 'ready') void this.check();
    }, CHECK_EVERY_MS);
  }

  async check(): Promise<UpdateStatus> {
    if (!this.supported) return this.status;
    this.wire();
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the 'error' event.
    }
    return this.status;
  }

  /** Restarts into the downloaded version (silent install, keeps the install folder and all data). */
  install(): boolean {
    if (this.status.state !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }
}
