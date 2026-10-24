// `librehub mouse`: command-line control for the Logitech G502 X PLUS. Same code path as the Electron app.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireAgentLock, SoftwareAgent } from './agent.js';
import type { HidTransport } from '../device/transport.js';
import { featureName } from './features.js';
import { G502X } from './g502x.js';
import { toHex } from './hidpp.js';
import { G502X_CONTROLS } from './onboard.js';
import { DPI_PRESETS, EFFECT_DEFAULTS, parseEffect } from './presets.js';
import { MouseService, type MouseAction, type MouseSnapshot } from './service.js';
import { openReceiver } from './transport.js';
import { KEYS, MEDIA } from './usages.js';
import { ButtonFunction } from './onboard.js';
import { defaultSoftwareFile, FREESTYLE_LEDS, formatSoftwareAction, parseFreestyle, SoftwareStore } from './software.js';

const USAGE = `usage: librehub mouse <command>
  status [--json]                         device, mode, live DPI/report rate, all five profiles
  mode <onboard|host>                     onboard = run from saved profiles (use this on Linux)
  profile <1-5>                           make a profile active (onboard mode)
  dpi-level <0-4>                         switch the active profile's DPI level
  startup-effect <on|off>                 animation when the mouse powers on

  profile <n> show [--json]
  profile <n> enable | disable | restore  restore = factory settings for that slot
  profile <n> report-rate <125|250|500|1000>
  profile <n> dpi <d1,d2,...> [--default <i>] [--shift <i>]   up to 5 levels, 100..25600 step 50;
                                          indexes are 0-based and default to the current ones
  profile <n> dpi-preset <name>           ${DPI_PRESETS.map((p) => p.name).join(', ')}
  profile <n> name <text|-->              -- clears the name
  profile <n> button <control> <assignment> [--gshift]   see "controls"
  profile <n> freestyle <#rrggbb|8 colours left to right|off>   per-LED colours (needs the agent)
  profile <n> lighting <effect>           what the LEDs do while you use the mouse
  profile <n> inactive-lighting <effect|dim[:percent]>
  profile <n> dim-after <seconds|never>   switch to the inactive lighting
  profile <n> off-after <seconds|never>   turn all LEDs off

  controls                                list controls and what they can be set to
  agent                                   run software actions and Freestyle (until Ctrl-C);
                                          the app does this itself while it runs
  backup <file.json>                      save all 16 onboard-memory sectors
  restore <file.json>                     write them back
  features | watch                        (add --debug to see raw HID traffic)

effects: ${Object.keys(EFFECT_DEFAULTS).join(' | ')}
  fixed:#rrggbb  cycle:<ms>:<bright%>  breathing:#rrggbb:<ms>:<bright%>
  wave:<ms>:<horizontal|reverse-horizontal>:<bright%>  pulsar-point:<frame ms 32-64>:<bright%>`;

interface Options {
  json: boolean;
  gshift: boolean;
  debug: boolean;
  defaultIdx?: string;
  shiftIdx?: string;
}

/** Pull the --flags out of the arguments. */
function parseArgs(raw: string[]): { args: string[]; opts: Options } {
  const args = [...raw];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    args.splice(i, 2);
    return v;
  };
  const has = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const opts = { debug: has('--debug'), json: has('--json'), gshift: has('--gshift'), defaultIdx: flag('--default'), shiftIdx: flag('--shift') };
  return { args, opts };
}

const int = (v: string | undefined, what: string) => {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) throw new Error(`expected ${what} as an integer, got "${v}"`);
  return n;
};
const seconds = (v: string | undefined) => {
  if (v === 'never') return null;
  const n = int(v, 'seconds');
  if (n < 1 || n > 65534) throw new Error(`seconds must be 1..65534 or "never", got ${n}`);
  return n;
};
const fmtSeconds = (s: number | null) => (s === null ? 'never' : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

function printProfile(p: MouseSnapshot['profiles'][number], active: boolean): void {
  const dpi = p.dpiLevels.map((d, k) => (k === p.defaultDpiIndex ? `[${d}]` : String(d)) + (k === p.shiftDpiIndex ? '*' : '')).join(' ');
  console.log(`profile ${p.slot}${active ? ' (active)' : ''}${p.enabled ? '' : ' (disabled)'}  ${p.name ?? ''}`);
  console.log(`  report rate  ${p.reportRateHz} Hz`);
  console.log(`  DPI          ${dpi}     [default] *shift`);
  console.log(`  lighting     ${p.lighting.active}; after ${fmtSeconds(p.dimAfterSeconds)} idle: ${p.lighting.inactive}; off after ${fmtSeconds(p.lightsOffAfterSeconds)}`);
  if (p.freestyle !== 'off') console.log(`  freestyle    ${p.freestyle}  (left to right; shown while the agent runs)`);
  for (const b of p.buttons) console.log(`  ${b.control.padEnd(11)} ${b.binding.padEnd(24)} g-shift: ${b.gshift}`);
}

export function printStatus(s: MouseSnapshot): void {
  const fw = s.device.firmware.map((f) => `${f.name} ${f.version}`).join(', ');
  console.log(`${s.device.name}  serial ${s.device.serial}  firmware ${fw}  HID++ ${s.device.protocol}`);
  console.log(`battery        ${s.battery.percent}% (${s.battery.charging})`);
  console.log(`mode           ${s.mode}${s.mode === 'host' ? ' (software control: G Hub or this app drives the mouse live)' : ''}`);
  if (s.mode === 'onboard') console.log(`active         profile ${s.activeProfile}, DPI level ${s.dpi.level}`);
  console.log(`sensor now     ${s.dpi.current} DPI, ${s.reportRateHz} Hz`);
  console.log(`wheel          ${s.wheel.ratchet}${s.wheel.highResolution ? ', high resolution' : ''}${s.wheel.inverted ? ', inverted' : ''}`);
  console.log(`startup effect ${s.startupEffect ? 'on' : 'off'}`);
  for (const p of s.profiles) printProfile(p, s.mode === 'onboard' && p.slot === s.activeProfile);
}

function printControls(): void {
  console.log('controls (onboard order, G Hub slot, where):');
  for (const c of G502X_CONTROLS) console.log(`  ${c.id.padEnd(11)} ${c.ghub.padEnd(8)} ${c.label} — ${c.where}`);
  console.log(`\nbindings:
  mouse:<left|right|middle|back|forward|1..16>[+...]
  key:[ctrl+][shift+][alt+][gui+]<key>     keys: a-z 0-9 f1-f24 ${Object.keys(KEYS).filter((k) => k.length > 3 && !/^(f\d|kp-\d)/.test(k)).join(' ')}
  media:<${Object.keys(MEDIA).join('|')}>
  fn:<${Object.keys(ButtonFunction).join('|')}>
  disabled      does nothing (G Hub's "Disable")
  default       not remapped: the control keeps its native behaviour

stored on the mouse as macros (they work with nothing running):
  text:<text>                  types it (printable ASCII, US layout; about 40 characters)
  double-click
  macro:<step>, <step>, ...    steps: ctrl+c (a key or combo)  50ms (a pause)  mouse:left
                               media:mute  down:shift / up:shift  down:mouse:left  wheel:-3

performed by the computer while the app or "librehub mouse agent" runs (the mouse does nothing itself):
  open:<app, file or URL>      e.g. open:/Applications/Calculator.app  open:https://example.com
  run:<shell command>          e.g. run:firefox  run:loginctl lock-session

Freestyle LEDs, left to right: ${FREESTYLE_LEDS.map((l) => `${l.led} (${l.where})`).join(', ')}`);
}

/** Run the agent in the foreground until interrupted. */
async function runAgent(svc: MouseService, store: SoftwareStore): Promise<void> {
  const lockFile = join(dirname(store.file), 'g502x-agent.lock');
  const release = acquireAgentLock(lockFile);
  if (!release) throw new Error(`another agent is running (the app, or "librehub mouse agent"); see ${lockFile}`);
  const agent = new SoftwareAgent(svc, store, { watch: true });
  agent.on('action', (e) => console.log(`${e.control}${e.layer === 'gshift' ? ' (g-shift)' : ''}: ${formatSoftwareAction(e.action)}`));
  agent.on('state', (s) => console.log(s.profile === null ? 'host mode: nothing to do until the mouse is in onboard mode' : `following profile ${s.profile}`));
  agent.on('error', (err) => console.error(`agent: ${(err as Error).message}`));
  try {
    await agent.start();
    console.log('agent running; Ctrl-C to stop');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await agent.stop().catch(() => undefined);
    release();
  }
}

/** Connect and read everything (for `librehub status`); a sleeping mouse fails after `wakeTimeoutMs`. */
export async function readMouseStatus(open: () => HidTransport = openReceiver, wakeTimeoutMs = 3000): Promise<MouseSnapshot> {
  const mouse = await G502X.connect(open(), { wakeTimeoutMs });
  try {
    return await new MouseService(mouse, new SoftwareStore(defaultSoftwareFile())).snapshot();
  } finally {
    mouse.close();
  }
}

/** Run one `librehub mouse` command. `open` is injectable so tests can use a simulated receiver. */
export async function runCli(raw: string[], open: () => HidTransport = openReceiver): Promise<void> {
  const { args: argv, opts } = parseArgs(raw);
  const { json, debug } = opts;
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') return void console.log(USAGE);
  if (cmd === 'controls') return printControls();

  const mouse = await G502X.connect(open(), {
    wakeTimeoutMs: 20000,
    log: debug ? (dir, b) => console.error(`${dir === 'out' ? '>>' : '<<'} ${toHex(b)}`) : undefined,
  });
  mouse.on('waiting', () => process.stderr.write('The mouse is asleep; move it to wake it up...\n'));
  const store = new SoftwareStore(defaultSoftwareFile());
  const svc = new MouseService(mouse, store);
  const apply = (a: MouseAction) => svc.apply(a);
  try {
    switch (cmd) {
      case 'status': {
        const s = await svc.snapshot();
        if (json) console.log(JSON.stringify(s, null, 2));
        else printStatus(s);
        return;
      }
      case 'mode':
        if (args[0] !== 'onboard' && args[0] !== 'host') throw new Error('mode must be onboard or host');
        return await apply({ type: 'mode', mode: args[0] });
      case 'dpi-level':
        return await apply({ type: 'dpiLevel', index: int(args[0], 'level') });
      case 'startup-effect':
        if (args[0] !== 'on' && args[0] !== 'off') throw new Error('expected on or off');
        return await apply({ type: 'startupEffect', enabled: args[0] === 'on' });
      case 'profile':
        return await profileCommand(svc, int(args[0], 'profile'), args.slice(1), opts);
      case 'backup': {
        if (!args[0]) throw new Error('backup needs a file name');
        const backup = await svc.backup();
        writeFileSync(args[0], JSON.stringify(backup, null, 1));
        console.log(`saved ${Object.keys(backup.sectors).length} sectors to ${args[0]}`);
        return;
      }
      case 'restore': {
        if (!args[0]) throw new Error('restore needs a file name');
        await svc.restore(JSON.parse(readFileSync(args[0], 'utf8')), (s) => console.log(`sector ${s} restored`));
        return;
      }
      case 'features':
        for (const f of mouse.features) console.log(`${String(f.index).padStart(3)}  0x${f.id.toString(16).padStart(4, '0')}  v${f.version}  ${featureName(f.id)}`);
        return;
      case 'agent':
        return await runAgent(svc, store);
      case 'watch':
        for (const ev of ['battery', 'connection', 'onboard', 'activity']) mouse.on(ev, (v) => console.log(ev, JSON.stringify(v)));
        console.log('watching; Ctrl-C to stop');
        await new Promise(() => undefined);
        return;
      default:
        throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } finally {
    if (cmd !== 'watch') mouse.close();
  }
}

async function profileCommand(svc: MouseService, profile: number, args: string[], opts: Options): Promise<void> {
  const { json, gshift, defaultIdx, shiftIdx } = opts;
  const [sub, ...rest] = args;
  const apply = (a: MouseAction) => svc.apply(a);
  switch (sub) {
    case undefined:
      return await apply({ type: 'activeProfile', profile });
    case 'show': {
      const s = await svc.snapshot();
      const p = s.profiles[profile - 1];
      if (!p) throw new Error(`no profile ${profile}`);
      if (json) console.log(JSON.stringify(p, null, 2));
      else printProfile(p, s.mode === 'onboard' && s.activeProfile === profile);
      return;
    }
    case 'enable':
    case 'disable':
      return await apply({ type: 'profileEnabled', profile, enabled: sub === 'enable' });
    case 'restore':
      return await apply({ type: 'restoreProfile', profile });
    case 'report-rate':
      return await apply({ type: 'reportRate', profile, hz: int(rest[0], 'Hz') });
    case 'dpi': {
      const levels = (rest[0] ?? '').split(',').map((d) => int(d, 'DPI'));
      return await apply({
        type: 'dpi',
        profile,
        levels,
        defaultIndex: defaultIdx === undefined ? undefined : int(defaultIdx, 'index'),
        shiftIndex: shiftIdx === undefined ? undefined : int(shiftIdx, 'index'),
      });
    }
    case 'dpi-preset':
      return await apply({ type: 'dpiPreset', profile, preset: rest[0] ?? '' });
    case 'name':
      return await apply({ type: 'name', profile, name: rest[0] === '--' ? null : rest.join(' ') });
    case 'button':
      if (rest.length < 2) throw new Error('usage: profile <n> button <control> <assignment> [--gshift]');
      // Text and commands may contain spaces: everything after the control is the assignment.
      return await apply({ type: 'button', profile, control: rest[0], layer: gshift ? 'gshift' : 'base', assignment: rest.slice(1).join(' ') });
    case 'freestyle':
      return await apply({ type: 'freestyle', profile, colors: parseFreestyle(rest.join('')) });
    case 'lighting':
      return await apply({ type: 'lighting', profile, target: 'active', effect: parseEffect(rest[0] ?? '') });
    case 'inactive-lighting': {
      const t = rest[0] ?? '';
      if (t.startsWith('dim')) return await apply({ type: 'lighting', profile, target: 'inactive', effect: 'dim', dimPercent: t.includes(':') ? int(t.split(':')[1], 'percent') : 50 });
      return await apply({ type: 'lighting', profile, target: 'inactive', effect: parseEffect(t) });
    }
    case 'dim-after':
      return await apply({ type: 'inactivity', profile, dimAfterSeconds: seconds(rest[0]) });
    case 'off-after':
      return await apply({ type: 'inactivity', profile, lightsOffAfterSeconds: seconds(rest[0]) });
    default:
      throw new Error(`unknown profile command "${sub}"\n\n${USAGE}`);
  }
}
