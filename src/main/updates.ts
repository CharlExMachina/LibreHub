// Updates from GitHub Releases, for the AppImage. A new release is downloaded in the background
// and installed when the app quits (or right away from the tray or Settings). Running from a
// checkout (`npm start`) there is nothing to update, so the updater stays off.

import { app } from 'electron';
import updater, { type AppUpdater } from 'electron-updater';

export type UpdateState =
  | { status: 'off' }
  | { status: 'idle' | 'checking' | 'latest' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; error: string };

const HOURS = 3_600_000;

/** The updater's errors carry whole HTTP dumps; say what went wrong in a few words. */
export function describeUpdateError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|net::ERR_/.test(msg)) return 'no connection to GitHub';
  if (/\b404\b/.test(msg)) return 'no published release found on GitHub';
  if (/\b(403|429)\b/.test(msg)) return 'GitHub is limiting requests; it’ll try again later';
  if (/sha512 checksum mismatch/i.test(msg)) return 'the download was damaged; it’ll try again later';
  return msg.split('\n')[0].slice(0, 160);
}

export class Updates {
  state: UpdateState = { status: 'off' };
  private timer?: ReturnType<typeof setInterval>;
  /** Created only when enabled: electron-updater sets itself up on first use. */
  private readonly autoUpdater?: AppUpdater;

  /**
   * `feedUrl` points the updater at a plain web folder instead of GitHub (for trying an update
   * locally; set LIBRE_HUB_UPDATE_URL).
   */
  constructor(private readonly opts: { enabled: boolean; onChange: (state: UpdateState) => void; feedUrl?: string }) {
    if (!opts.enabled) return;
    this.state = { status: 'idle' };
    const autoUpdater = (this.autoUpdater = updater.autoUpdater);
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    if (opts.feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: opts.feedUrl });
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => {
      // A finished download stays installable even if a later check fails (e.g. offline).
      if (this.state.status !== 'ready') this.set({ status: 'error', error: describeUpdateError(err) });
    });
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Check now, then every six hours. */
  start(delayMs = 15_000): void {
    if (!this.opts.enabled) return;
    setTimeout(() => void this.check(), delayMs);
    this.timer = setInterval(() => void this.check(), 6 * HOURS);
  }

  async check(): Promise<void> {
    if (!this.autoUpdater || this.state.status === 'ready' || this.state.status === 'downloading') return;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch {
      // reported through the 'error' event
    }
  }

  /** Quit, install the downloaded release and start it again. */
  install(): void {
    if (!this.autoUpdater || this.state.status !== 'ready') return;
    // The updater starts the new version before this one has quit. Let it have the
    // single-instance lock, or it would hand over to this copy and exit.
    app.releaseSingleInstanceLock();
    this.autoUpdater.quitAndInstall(true, true);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.opts.onChange(state);
  }
}
