// Start the app when the user logs in, hidden in the tray. Linux uses an XDG autostart entry,
// macOS a LaunchAgent. Both point at the exact command running now (which also works for an
// unpackaged `npm start` checkout), so the entry is rewritten on each launch in case it moved.
// On Linux the app also installs a launcher entry: it's what gives the window its name and icon.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Launch {
  command: string;
  args: string[];
}

/** Also the Linux desktop file name, which Electron uses as the Wayland app id (package.json desktopName). */
export const APP_ID = 'com.charlexmachina.LibreHub';
export const APP_NAME = 'Libre Hub';

export function autostartFile(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', `${APP_ID}.desktop`);
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${APP_ID}.plist`);
  return undefined;
}

/** Where an icon of one size goes in the user's icon theme, so entries can name it (Icon=APP_ID). */
export function iconFile(size: number, home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'icons', 'hicolor', `${size}x${size}`, 'apps', `${APP_ID}.png`);
}

export function launcherFile(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  return platform === 'linux' ? join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications', `${APP_ID}.desktop`) : undefined;
}

/** Entries written by earlier versions, under the old name. */
const legacyFiles = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}) =>
  platform === 'linux' ? [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'logitech-manager.desktop')]
    : platform === 'darwin' ? [join(home, 'Library', 'LaunchAgents', 'com.charlexmachina.logitech-manager.plist')]
      : [];

/** Quote one Exec argument (Desktop Entry spec: quoting rules, then string escapes, then %). */
export function execArg(arg: string): string {
  const quoted = /^[\w\-./=:+,@]+$/.test(arg) ? arg : `"${arg.replace(/[\\"`$]/g, '\\$&')}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

export function desktopEntry(launch: Launch, icon?: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Settings for the Logitech A50 X headset',
    `Exec=${[launch.command, ...launch.args].map(execArg).join(' ')}`,
    ...(icon ? [`Icon=${icon}`] : []),
    'Terminal=false',
    'Categories=AudioVideo;Audio;Settings;',
    `StartupWMClass=${APP_ID}`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchAgent(launch: Launch): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${APP_ID}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[launch.command, ...launch.args].map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export class Autostart {
  readonly file?: string;

  constructor(
    private readonly launch: Launch,
    private readonly opts: { platform: NodeJS.Platform; home: string; env?: NodeJS.ProcessEnv; icon?: string },
  ) {
    this.file = autostartFile(opts.platform, opts.home, opts.env);
  }

  get supported(): boolean {
    return !!this.file;
  }

  get enabled(): boolean {
    return !!this.file && existsSync(this.file);
  }

  /** Move an entry from the old name over to this one. */
  migrate(): void {
    const old = legacyFiles(this.opts.platform, this.opts.home, this.opts.env).filter((f) => existsSync(f));
    for (const f of old) rmSync(f, { force: true });
    if (old.length) this.set(true);
  }

  /**
   * Install the app icon into the user's icon theme (Linux). An AppImage's own files live in a
   * mount that changes every run and is gone once it quits, so desktop entries can't point there.
   */
  installIcons(pngs: Map<number, Buffer>): void {
    if (this.opts.platform !== 'linux') return;
    for (const [size, png] of pngs) {
      const file = iconFile(size, this.opts.home, this.opts.env);
      if (existsSync(file) && readFileSync(file).equals(png)) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
    }
  }

  /** Install or update the Linux launcher (no-op elsewhere). */
  installLauncher(): void {
    const file = launcherFile(this.opts.platform, this.opts.home, this.opts.env);
    if (!file) return;
    const entry = desktopEntry({ ...this.launch, args: this.launch.args.filter((a) => a !== '--hidden') }, this.opts.icon)
      .replace('X-GNOME-Autostart-enabled=true\n', '');
    if (existsSync(file) && readFileSync(file, 'utf8') === entry) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry);
  }

  set(enabled: boolean): void {
    if (!this.file) throw new Error('starting at login isn’t supported on this system');
    if (!enabled) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.opts.platform === 'darwin' ? launchAgent(this.launch) : desktopEntry(this.launch, this.opts.icon));
  }

  /** Keep an existing entry pointing at this copy of the app. */
  refresh(): void {
    if (this.enabled) this.set(true);
  }
}
