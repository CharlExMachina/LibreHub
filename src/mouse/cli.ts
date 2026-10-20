#!/usr/bin/env node
// g502x: command-line control for the Logitech G502 X PLUS. Same code path as the Electron app.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HidTransport } from '../device/transport.js';
import { featureName } from './features.js';
import { G502X } from './g502x.js';
import { fromHex, toHex } from './hidpp.js';
import { G502X_CONTROLS } from './onboard.js';
import { DPI_PRESETS, EFFECT_DEFAULTS, parseEffect } from './presets.js';
import { MouseService, type MouseAction, type MouseSnapshot } from './service.js';
import { openReceiver } from './transport.js';
import { KEYS, MEDIA, parseBinding } from './usages.js';
import { ButtonFunction } from './onboard.js';

const USAGE = `usage: g502x <command>
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
  profile <n> button <control> <binding> [--gshift]
  profile <n> lighting <effect>           what the LEDs do while you use the mouse
  profile <n> inactive-lighting <effect|dim[:percent]>
  profile <n> dim-after <seconds|never>   switch to the inactive lighting
  profile <n> off-after <seconds|never>   turn all LEDs off

  controls                                list controls and the binding syntax
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
  for (const b of p.buttons) console.log(`  ${b.control.padEnd(11)} ${b.binding.padEnd(24)} g-shift: ${b.gshift}`);
}

function printStatus(s: MouseSnapshot): void {
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
  default       not remapped: the control keeps its native behaviour`);
}

/** Run one g502x command. `open` is injectable so tests can use a simulated receiver. */
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
  const svc = new MouseService(mouse);
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
        const { sectorCount } = await mouse.getOnboardDescription();
        const sectors: Record<string, string> = {};
        for (let s = 0; s < sectorCount; s++) sectors[s] = toHex(await mouse.readSector(s));
        writeFileSync(args[0], JSON.stringify({ device: (await mouse.getInfo()).name, savedAt: new Date().toISOString(), sectors }, null, 1));
        console.log(`saved ${sectorCount} sectors to ${args[0]}`);
        return;
      }
      case 'restore': {
        if (!args[0]) throw new Error('restore needs a file name');
        const saved = JSON.parse(readFileSync(args[0], 'utf8')) as { sectors: Record<string, string> };
        for (const [s, hex] of Object.entries(saved.sectors)) {
          const want = fromHex(hex);
          if (toHex(await mouse.readSector(+s)) === hex) continue;
          if (want.every((b) => b === 0xff)) await mouse.eraseSector(+s);
          else await mouse.writeSector(+s, want);
          console.log(`sector ${s} restored`);
        }
        if ((await mouse.getMode()) === 'onboard') await mouse.setActiveProfile(await mouse.getActiveProfile()).catch(() => undefined);
        return;
      }
      case 'features':
        for (const f of mouse.features) console.log(`${String(f.index).padStart(3)}  0x${f.id.toString(16).padStart(4, '0')}  v${f.version}  ${featureName(f.id)}`);
        return;
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
      if (rest.length < 2) throw new Error('usage: profile <n> button <control> <binding> [--gshift]');
      return await apply({ type: 'button', profile, control: rest[0], layer: gshift ? 'gshift' : 'base', binding: parseBinding(rest[1]) });
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

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
