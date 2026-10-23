// Performs a software action (software.ts) on this computer.

import { spawn } from 'node:child_process';
import type { SoftwareAction } from './software.js';

/** The program and arguments that perform an action on a platform. */
export function commandFor(a: SoftwareAction, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (a.type === 'run') return platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', a.command]] : ['/bin/sh', ['-c', a.command]];
  if (platform === 'darwin') return ['open', [a.target]];
  if (platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', 'start', '""', a.target]];
  return ['xdg-open', [a.target]];
}

/** Start the action detached, so it outlives the agent and never blocks it. */
export function runAction(a: SoftwareAction, onError: (err: Error) => void = () => undefined): void {
  const [cmd, args] = commandFor(a);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', onError);
    child.unref();
  } catch (err) {
    onError(err as Error);
  }
}
