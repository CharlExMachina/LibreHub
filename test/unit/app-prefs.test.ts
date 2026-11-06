import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autostartFile, desktopEntry, execArg, iconFile, launchAgent, launcherFile } from '../../src/main/autostart.js';
import { DEFAULT_PREFS, normalize } from '../../src/main/prefs.js';
import { parseLogindLine } from '../../src/main/session.js';
import { describeUpdateError, envForNewAppImage, RUN_WITHOUT_INHERITED_FILES } from '../../src/main/updates.js';

describe('preferences', () => {
  it('fills defaults and ignores junk', () => {
    expect(normalize(undefined)).toEqual(DEFAULT_PREFS);
    // Files from before the per-setting choices went away still load.
    const p = normalize({ keepSettings: true, closeToTray: 'yes', keepGroups: { volume: true }, extra: 1 });
    expect(p).toEqual({ ...DEFAULT_PREFS, keepSettings: true });
  });

  it('keeps a known appearance and falls back to the system one', () => {
    expect(normalize({}).theme).toBe('system');
    expect(normalize({ theme: 'light' }).theme).toBe('light');
    expect(normalize({ theme: 'dark' }).theme).toBe('dark');
    expect(normalize({ theme: 'sepia' }).theme).toBe('system');
    expect(normalize({ theme: true }).theme).toBe('system');
  });

  it('keeps a known glass and falls back to clear', () => {
    expect(normalize({}).glass).toBe('clear');
    expect(normalize({ glass: 'tinted' }).glass).toBe('tinted');
    expect(normalize({ glass: 'frosted' }).glass).toBe('clear');
  });
});

describe('start at login', () => {
  it('writes an XDG autostart entry that survives odd paths', () => {
    expect(autostartFile('linux', '/home/u', {})).toBe('/home/u/.config/autostart/com.charlexmachina.LibreHub.desktop');
    expect(autostartFile('linux', '/home/u', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/autostart/com.charlexmachina.LibreHub.desktop');
    expect(launcherFile('linux', '/home/u', {})).toBe('/home/u/.local/share/applications/com.charlexmachina.LibreHub.desktop');
    expect(launcherFile('darwin', '/Users/u')).toBeUndefined();
    expect(iconFile(64, '/home/u', {})).toBe('/home/u/.local/share/icons/hicolor/64x64/apps/com.charlexmachina.LibreHub.png');
    expect(desktopEntry({ command: '/a', args: [] }, 'com.charlexmachina.LibreHub')).toContain('Icon=com.charlexmachina.LibreHub\n');
    expect(autostartFile('win32', 'C:\\Users\\u')).toBeUndefined();
    expect(execArg('/usr/bin/electron')).toBe('/usr/bin/electron');
    expect(execArg('/home/u/My Apps/a50x')).toBe('"/home/u/My Apps/a50x"');
    expect(execArg('/tmp/$x "q" 100%')).toBe('"/tmp/\\\\$x \\\\"q\\\\" 100%%"');
    const entry = desktopEntry({ command: '/opt/e/electron', args: ['/home/u/dev/logitech manager', '--hidden'] }, '/i.png');
    expect(entry).toContain('Exec=/opt/e/electron "/home/u/dev/logitech manager" --hidden\n');
    expect(entry).toContain('Icon=/i.png');
    expect(entry).toContain('Name=Libre Hub\n');
    expect(entry).toContain('StartupWMClass=com.charlexmachina.LibreHub\n');
    expect(entry.startsWith('[Desktop Entry]\nType=Application\n')).toBe(true);
  });

  it('writes a macOS LaunchAgent', () => {
    expect(autostartFile('darwin', '/Users/u')).toBe('/Users/u/Library/LaunchAgents/com.charlexmachina.LibreHub.plist');
    const plist = launchAgent({ command: '/A&B/Electron', args: ['--hidden'] });
    expect(plist).toContain('<string>/A&amp;B/Electron</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
  });
});

describe('unlock detection on Linux', () => {
  it('reads logind lock state from gdbus monitor output', () => {
    const path = '/org/freedesktop/login1/session/_32';
    expect(parseLogindLine(`${path}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])`))
      .toEqual({ session: path, locked: true });
    expect(parseLogindLine(`${path}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'IdleHint': <false>, 'LockedHint': <false>}, @as [])`))
      .toEqual({ session: path, locked: false });
    expect(parseLogindLine(`${path}: org.freedesktop.login1.Session.Unlock ()`)).toEqual({ session: path, locked: false });
    expect(parseLogindLine(`${path}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'IdleHint': <true>}, @as [])`)).toBeUndefined();
    expect(parseLogindLine('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)')).toBeUndefined();
  });
});

describe('update errors', () => {
  it('turns updater failures into short reasons', () => {
    expect(describeUpdateError(new Error('404 \n"method: GET url: https://github.com/x/y/releases.atom\n..."'))).toBe('no published release found on GitHub');
    expect(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('no connection to GitHub');
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('no connection to GitHub');
    expect(describeUpdateError(new Error('something odd\nwith details'))).toBe('something odd');
  });
});

describe('starting the updated AppImage', () => {
  it('leaves out what the old AppImage added to the environment', () => {
    const appDir = '/tmp/.mount_Libre-abc123';
    const env = envForNewAppImage({
      APPDIR: appDir,
      APPIMAGE: '/home/me/Applications/Libre-Hub-x86_64.AppImage',
      ARGV0: 'Libre-Hub-x86_64.AppImage',
      OWD: '/home/me',
      PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${appDir}/usr/lib`,
      XDG_DATA_DIRS: `${appDir}/usr/share/::/usr/share/gnome:/usr/local/share/:/usr/share/`,
      // Only the mount itself and what is under it: a folder that merely starts the same way stays.
      GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas:${appDir}-other/schemas`,
      HOME: '/home/me',
    });
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/',
      GSETTINGS_SCHEMA_DIR: `${appDir}-other/schemas`,
      HOME: '/home/me',
    });
  });

  it('keeps the environment as it is when not started from an AppImage', () => {
    expect(envForNewAppImage({ PATH: '/usr/bin', HOME: '/home/me' })).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });

  it.runIf(process.platform === 'linux')('runs the new AppImage with only stdin, stdout and stderr open', () => {
    // A stand-in for the AppImage that lists the files it was started with.
    const target = join(mkdtempSync(join(tmpdir(), 'librehub-')), 'fake.AppImage');
    writeFileSync(target, '#!/bin/sh\nexec ls /proc/self/fd\n');
    chmodSync(target, 0o755);
    // Files 3, 4 and 12 are open in the shell that starts it, as the old copy's files would be.
    const files = (script: string) => {
      const run = spawnSync('bash', ['-c', `exec 12</dev/null; exec bash -c '${script}' "$0"`, target], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      // ls opens its own directory listing, as the lowest free number.
      return run.stdout.trim().split(/\s+/).map(Number).sort((a, b) => a - b);
    };
    // Without the script they reach it (along with whatever this test runner has open).
    expect(files('exec "$0"')).toEqual(expect.arrayContaining([3, 4, 12]));
    expect(files(RUN_WITHOUT_INHERITED_FILES)).toEqual([0, 1, 2, 3]);
  });
});
