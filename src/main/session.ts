// Notice when the user unlocks the session. Electron only reports this on macOS and Windows; on
// Linux, desktops (KDE, GNOME and others) tell logind through the session's LockedHint, which
// `gdbus monitor` prints as it changes.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type SessionEvent = { session: string; locked: boolean };

/**
 * One line of `gdbus monitor --system --dest org.freedesktop.login1`, e.g.
 * /org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])
 * /org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Unlock ()
 */
export function parseLogindLine(line: string): SessionEvent | undefined {
  const path = /^(\/org\/freedesktop\/login1\/session\/\S+?):/.exec(line)?.[1];
  if (!path) return undefined;
  const hint = /'org\.freedesktop\.login1\.Session', \{[^}]*'LockedHint': <(true|false)>/.exec(line);
  if (hint) return { session: path, locked: hint[1] === 'true' };
  if (/ org\.freedesktop\.login1\.Session\.Unlock \(/.test(line)) return { session: path, locked: false };
  if (/ org\.freedesktop\.login1\.Session\.Lock \(/.test(line)) return { session: path, locked: true };
  return undefined;
}

/** Calls `onUnlock` each time a locked session is unlocked. Returns a stop function, or undefined if unavailable. */
export function watchLinuxUnlock(onUnlock: () => void): (() => void) | undefined {
  let child;
  try {
    child = spawn('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.login1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
  // Without gdbus there's no unlock check; wake-ups and reconnects still work.
  child.on('error', (err) => console.error('unlock watch unavailable:', err.message));
  const locked = new Map<string, boolean>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const ev = parseLogindLine(line);
    if (!ev) return;
    const was = locked.get(ev.session);
    locked.set(ev.session, ev.locked);
    if (was && !ev.locked) onUnlock();
  });
  return () => child.kill();
}
