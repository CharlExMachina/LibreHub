// Updates from GitHub Releases, for the AppImage. A new release is downloaded in the background
// and installed when the app quits (or right away from the tray or Settings). Running from a
// checkout (`npm start`) there is nothing to update, so the updater stays off.

import { spawn } from 'node:child_process';
import { app } from 'electron';
import updater, { type AppUpdater, type BaseUpdater } from 'electron-updater';

export type UpdateState =
  | { status: 'off' }
  | { status: 'idle' | 'checking' | 'latest' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; error: string };

const HOURS = 3_600_000;

/**
 * A bash script that closes every file it inherited except stdin, stdout and stderr, then runs
 * `$0`. The new AppImage is started through it (see `Updates.install`).
 */
export const RUN_WITHOUT_INHERITED_FILES =
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done 2>/dev/null; exec "$0"';

/**
 * The environment for the new AppImage: this one's, without what this copy's AppImage runtime
 * and launcher added (its APPDIR and the paths under it). The new copy's runtime adds its own.
 */
export function envForNewAppImage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { APPDIR: appDir, APPIMAGE: _image, ARGV0: _argv0, OWD: _owd, ...rest } = env;
  if (!appDir) return rest;
  for (const key of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    const value = rest[key];
    if (value === undefined) continue;
    const kept = value.split(':').filter((dir) => dir && dir !== appDir && !dir.startsWith(`${appDir}/`));
    if (kept.length) rest[key] = kept.join(':');
    else delete rest[key];
  }
  return rest;
}

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
   * `appImage` is the AppImage this copy runs from (none: running from source, updates off).
   * `feedUrl` points the updater at a plain web folder instead of GitHub (for trying an update
   * locally; set LIBRE_HUB_UPDATE_URL).
   */
  constructor(private readonly opts: { appImage?: string; onChange: (state: UpdateState) => void; feedUrl?: string }) {
    if (!opts.appImage) return;
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
    return !!this.opts.appImage;
  }

  /** Check now, then every six hours. */
  start(delayMs = 15_000): void {
    if (!this.opts.appImage) return;
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
    const appImage = this.opts.appImage;
    if (!this.autoUpdater || !appImage || this.state.status !== 'ready') return;
    // The updater only swaps the file here; this copy starts the new one. electron-updater would
    // start it with Node's spawn, and the new copy would inherit every file this one has open
    // without close-on-exec: Chromium's .pak files, ICU data and V8 snapshot, all on this
    // AppImage's mount, and the pipe its runtime waits on to unmount. The old mount, its runtime
    // and the deleted old AppImage then stay until the app quits, and the next update hands them
    // on again. (Electron's relaunch closes them, but its helper runs from this mount, which is
    // gone the moment this copy quits, and it dies before starting anything.) So bash, from
    // outside the mount, closes what it inherited and runs the new AppImage.
    let target = appImage;
    const renamed = (file: string) => (target = file);
    this.autoUpdater.once('appimage-filename-updated', renamed);
    const installed = (this.autoUpdater as BaseUpdater).install(true, false);
    this.autoUpdater.off('appimage-filename-updated', renamed);
    if (!installed) return; // reported through the 'error' event
    // The new copy may start before this one is gone: let it have the single-instance lock, or
    // it would hand over to this copy and exit.
    app.releaseSingleInstanceLock();
    const child = spawn('/usr/bin/env', ['bash', '-c', RUN_WITHOUT_INHERITED_FILES, target], {
      detached: true,
      stdio: 'ignore',
      env: envForNewAppImage(process.env),
    });
    child.on('error', (err) => console.error('could not start the new version:', err.message));
    child.unref();
    app.quit();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.opts.onChange(state);
  }
}
