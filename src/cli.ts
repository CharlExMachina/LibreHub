#!/usr/bin/env node
// librehub: command-line control for the devices Libre Hub manages. Same code path as the app.
//
//   librehub headset <command>   the A50 X (src/headset-cli.ts)
//   librehub mouse <command>     the G502 X PLUS (src/mouse/cli.ts)
//   librehub camera <command>    the MX Brio (src/camera/cli.ts)
//   librehub status [--json]     all of them, whichever are connected

import { printStatus as printCamera, readCameraStatus, runCli as runCameraCli } from './camera/cli.js';
import { findCamera } from './camera/transport.js';
import { findA50X } from './device/transport.js';
import { printStatus as printHeadset, readHeadsetStatus, runHeadsetCli } from './headset-cli.js';
import { MouseUnavailableError, TimeoutError } from './mouse/g502x.js';
import { printStatus as printMouse, readMouseStatus, runCli as runMouseCli } from './mouse/cli.js';
import { findReceiver } from './mouse/transport.js';

const USAGE = `usage: librehub <device> <command>
  headset <command>     the A50 X headset (alias: a50x); "librehub headset help" lists its commands
  mouse <command>       the G502 X PLUS mouse (alias: g502x); "librehub mouse help" lists its commands
  camera <command>      the MX Brio webcam (alias: mx-brio); "librehub camera help" lists its commands
  status [--json]       every device, whichever are connected

examples:
  librehub headset set sidetone 3
  librehub mouse profile 1 dpi 800,1600,3200 --default 1
  librehub camera set fov 78 zoom 150`;

const DEVICES: Record<string, (args: string[]) => Promise<void>> = {
  headset: runHeadsetCli,
  a50x: runHeadsetCli,
  mouse: (args) => runMouseCli(args),
  g502x: (args) => runMouseCli(args),
  camera: (args) => runCameraCli(args),
  'mx-brio': (args) => runCameraCli(args),
};

/** Status of every device; one that isn't there is reported, not an error. */
async function status(json: boolean): Promise<void> {
  const why = (err: unknown, rule: string) => {
    if (err instanceof MouseUnavailableError) return 'asleep or switched off; move it to wake it up';
    if (err instanceof TimeoutError) return 'not answering; unplug it and plug it back in';
    const msg = (err as Error).message;
    return /permission denied/i.test(msg) ? `no permission to open it; install ${rule} (see the README)` : msg;
  };
  const read = async <T>(found: unknown, missing: string, rule: string, fn: () => Promise<T>) => {
    if (!found) return { error: missing };
    try {
      return { snapshot: await fn() };
    } catch (err) {
      return { error: why(err, rule) };
    }
  };
  const headset = await read(findA50X(), 'no base station found (USB 046d:0b0b)', 'linux/70-libre-hub.rules', readHeadsetStatus);
  const mouse = await read(findReceiver(), 'no Lightspeed receiver found', 'linux/70-libre-hub.rules', () => readMouseStatus());
  const camera = await read(await findCamera().catch(() => undefined), 'no MX Brio found (USB 046d:0944)', 'access to /dev/video* (the "video" group)', () => readCameraStatus());
  if (json) {
    console.log(JSON.stringify({ headset, mouse, camera }, null, 2));
    return;
  }
  if ('snapshot' in headset && headset.snapshot) printHeadset(headset.snapshot);
  else console.log(`A50 X: not connected (${headset.error})`);
  console.log('');
  if ('snapshot' in mouse && mouse.snapshot) printMouse(mouse.snapshot);
  else console.log(`G502 X PLUS: not connected (${mouse.error})`);
  console.log('');
  if ('snapshot' in camera && camera.snapshot) printCamera(camera.snapshot);
  else console.log(`MX Brio: not connected (${camera.error})`);
}

async function main(argv: string[]): Promise<void> {
  // Flags may come before the device too (librehub --json status).
  const at = argv.findIndex((a) => !a.startsWith('-'));
  const device = argv[at];
  const rest = [...argv.slice(0, Math.max(at, 0)), ...argv.slice(at + 1)];
  if (at < 0 || device === 'help') return void console.log(USAGE);
  if (device === 'status') return status(rest.includes('--json'));
  const run = DEVICES[device];
  if (!run) throw new Error(`unknown device "${device}"\n\n${USAGE}`);
  await run(rest);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`librehub: ${err.message}`);
  process.exit(1);
});
