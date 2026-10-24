// `librehub headset`: command-line control for the Logitech A50 X. Same code path as the Electron app.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioSplit, runCommand, type AudioSplitStatus } from './audio/split.js';
import { A50X } from './device/a50x.js';
import { openA50X } from './device/transport.js';
import { featureName } from './protocol/features.js';
import { HeadsetTones, MixerMic, type NoiseGateName, type TonesName } from './protocol/codecs.js';
import { CURATED_PRESETS, HEADPHONES, MIC } from './protocol/eq.js';
import { toHex } from './protocol/packet.js';
import { PresetStore } from './presets/store.js';
import { capture, groupsTouchedBy, pick } from './restore/settings.js';
import { RestoreStore } from './restore/store.js';
import { A50XService, type Action, type Snapshot } from './service.js';

const USAGE = `usage: librehub headset <command>
  status [--json]                       show everything
  set sidetone <0-6>
  set volume <0-21>
  set mute <on|off>
  set balance <0-12>                    6 = centered
  set sleep <0|15|30|60>                minutes; 0 = never
  set brightness <0-100>                base station LEDs
  set tones <none|all|minimal>
  set noise-gate <off|home|night|tournament>
  routing output <0-32> | output-mute <on|off>
  routing <mic|game|bluetooth|voice> <0-32> | <input>-mute <on|off>
  eq <mic|headphones>                   show bands
  eq <mic|headphones> preset <name>     curated: mic Default/Competition/Broadcast, headphones Default/Gaming/Media
  eq <mic|headphones> gains <g1,...,g10> dB, -6..6
  features                              list the device's feature table
  watch                                 print device events until Ctrl-C
  audio [status|setup|undo]             Linux: split the base station into "A50 X Game" and
                                        "A50 X Voice" outputs (chat apps go to Voice)
  options: --debug (print raw HID traffic)`;

function printAudio(s: AudioSplitStatus): void {
  if (!s.supported) {
    console.log(`audio split    unavailable: ${s.reason}`);
    return;
  }
  const state = !s.cardFound ? 'base station audio not found' : s.active ? 'on' : 'off';
  console.log(`audio split    ${state}  (rule ${s.installed === 'current' ? 'installed' : s.installed})`);
  if (s.active) {
    console.log(`  game         ${s.nodes.game}${s.defaultOutputIsGame ? '  (default output)' : ''}`);
    console.log(`  voice        ${s.nodes.voice}  (voice-chat apps)`);
    console.log(`  mic          ${s.nodes.mic}`);
    console.log(`  stream out   ${s.nodes.streamOut}`);
  }
}

async function audioCommand(sub = 'status'): Promise<void> {
  if (process.platform !== 'linux') throw new Error('audio splitting is Linux-only');
  const split = new AudioSplit({ run: runCommand, assetsDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'linux', 'wireplumber') });
  if (sub === 'status') printAudio(await split.status());
  else if (sub === 'setup') printAudio(await split.setup());
  else if (sub === 'undo') printAudio(await split.undo());
  else throw new Error('usage: librehub headset audio [status|setup|undo]');
}

// Same files the Electron app uses (its userData folder).
const appFile = (name: string) =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'logitech-manager', name)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'logitech-manager', name);
const presetsFile = () => appFile('presets.json');

const onOff = (v?: string) => {
  if (v === 'on') return true;
  if (v === 'off') return false;
  throw new Error(`expected on|off, got "${v}"`);
};
const int = (v?: string) => {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) throw new Error(`expected an integer, got "${v}"`);
  return n;
};
const instanceOf = (v?: string) => {
  if (v === 'mic') return MIC;
  if (v === 'headphones') return HEADPHONES;
  throw new Error(`expected mic|headphones, got "${v}"`);
};

export function printStatus(s: Snapshot): void {
  const pct = (g: number) => `${Math.round((g / s.routing.maxGain) * 100)}%`;
  console.log(`${s.device.model} "${s.device.name}"  fw ${s.device.firmware.version}  serial ${s.device.serial}`);
  console.log(`battery        ${s.battery}%`);
  console.log(`bluetooth      ${s.bluetoothHost ? `${s.bluetoothHost.name} (${s.bluetoothHost.address})` : 'none'}`);
  console.log(`sidetone       ${s.sidetone.step}/${s.sidetone.max}`);
  console.log(`volume         ${s.volume.level}/${s.volume.max}${s.volume.muted ? ' (muted)' : ''}`);
  console.log(`balance        ${s.balance.value}/${s.balance.max} (6 = centered)`);
  console.log(`sleep after    ${s.sleep.minutes === 0 ? 'never' : `${s.sleep.minutes} min`}`);
  console.log(`brightness     ${s.brightness}%`);
  console.log(`tones          ${s.tones}`);
  console.log(`noise gate     ${s.noiseGate.value}  (supported: ${s.noiseGate.supported.join(', ')})`);
  console.log(`stream output  ${pct(s.routing.output.gain)}${s.routing.output.muted ? ' (muted)' : ''}`);
  for (const i of s.routing.inputs) console.log(`  ${i.name.padEnd(12)} ${pct(i.gain)}${i.muted ? ' (muted)' : ''}`);
  for (const e of s.equalizers) {
    console.log(`${e.label} EQ: ${e.matches ?? 'custom (unsaved)'}`);
    console.log(`  ${e.frequencies.map((f, k) => `${f >= 1000 ? `${f / 1000}k` : f}Hz ${e.gainsDb[k] >= 0 ? '+' : ''}${e.gainsDb[k]}`).join('  ')}`);
  }
}

/** Connect to the headset and read everything (for `librehub status`). */
export async function readHeadsetStatus(): Promise<Snapshot> {
  const dev = await A50X.connect(openA50X());
  try {
    return await new A50XService(dev, new PresetStore(presetsFile())).snapshot();
  } finally {
    dev.close();
  }
}

/** Run one `librehub headset` command. */
export async function runHeadsetCli(argv: string[]): Promise<void> {
  const debug = argv.includes('--debug');
  const args = argv.filter((a) => !a.startsWith('--'));
  const [cmd, a1, a2, a3] = args;
  if (!cmd || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'audio') return audioCommand(a1);
  const dev = await A50X.connect(openA50X(), debug ? { log: (dir, b) => console.error(dir === 'out' ? 'OUT' : ' IN', toHex(b.slice(0, 3 + b[2]))) } : {});
  const svc = new A50XService(dev, new PresetStore(presetsFile()));
  // If the app keeps this headset's settings, save the change there too, or its next check would undo it.
  const apply = async (action: Action) => {
    await svc.apply(action);
    const kept = new RestoreStore(appFile('restore.json'));
    if (!(await kept.saved((await dev.getDeviceInfo()).serial))) return;
    const s = await svc.snapshot();
    await kept.remember(s.device.serial, pick(capture(s), groupsTouchedBy(action)));
  };
  try {
    switch (cmd) {
      case 'status': {
        const s = await svc.snapshot();
        if (argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
        else printStatus(s);
        break;
      }
      case 'features':
        for (const f of dev.features) console.log(`${String(f.index).padStart(2)}  0x${f.id.toString(16).padStart(4, '0')}  v${f.version}  ${featureName(f.id)}`);
        break;
      case 'set':
        switch (a1) {
          case 'sidetone': await apply({ type: 'sidetone', step: int(a2) }); break;
          case 'volume': await apply({ type: 'volume', level: int(a2) }); break;
          case 'mute': await apply({ type: 'mute', muted: onOff(a2) }); break;
          case 'balance': await apply({ type: 'balance', value: int(a2) }); break;
          case 'sleep': await apply({ type: 'sleep', minutes: int(a2) }); break;
          case 'brightness': await apply({ type: 'brightness', percent: int(a2) }); break;
          case 'tones':
            if (!(a2! in HeadsetTones.VALUES)) throw new Error(`tones must be one of ${Object.keys(HeadsetTones.VALUES).join('|')}`);
            await apply({ type: 'tones', value: a2 as TonesName });
            break;
          case 'noise-gate':
            if (!(a2! in MixerMic.GATES)) throw new Error(`noise gate must be one of ${Object.keys(MixerMic.GATES).join('|')}`);
            await apply({ type: 'noiseGate', value: a2 as NoiseGateName });
            break;
          default: throw new Error(`unknown setting "${a1}"\n${USAGE}`);
        }
        console.log('ok');
        break;
      case 'routing': {
        const { inputs } = await dev.getRouting();
        if (a1 === 'output') await apply({ type: 'routingOutput', gain: int(a2) });
        else if (a1 === 'output-mute') await apply({ type: 'routingOutput', muted: onOff(a2) });
        else {
          const [name, mute] = (a1 ?? '').split('-');
          const input = inputs.find((i) => i.name === name);
          if (!input) throw new Error(`unknown routing input "${name}" (have: ${inputs.map((i) => i.name).join(', ')})`);
          await apply(mute === 'mute' ? { type: 'routingInput', index: input.index, muted: onOff(a2) } : { type: 'routingInput', index: input.index, gain: int(a2) });
        }
        console.log('ok');
        break;
      }
      case 'eq': {
        const instance = instanceOf(a1);
        if (a2 === 'preset') {
          const p = CURATED_PRESETS[instance].findIndex((n) => n.toLowerCase() === (a3 ?? '').toLowerCase());
          if (p >= 0) await apply({ type: 'eqCurated', instance, preset: p });
          else {
            const custom = (await new PresetStore(presetsFile()).list(instance)).find((c) => c.name.toLowerCase() === (a3 ?? '').toLowerCase());
            if (!custom) throw new Error(`no preset "${a3}" (curated: ${CURATED_PRESETS[instance].join(', ')})`);
            await apply({ type: 'eqCustom', id: custom.id });
          }
          console.log('ok');
        } else if (a2 === 'gains') {
          await apply({ type: 'eqGains', instance, gainsDb: (a3 ?? '').split(',').map(Number) });
          console.log('ok');
        } else {
          const e = (await svc.snapshot()).equalizers[instance];
          console.log(`${e.label} EQ: ${e.matches ?? 'custom (unsaved)'}`);
          e.frequencies.forEach((f, k) => console.log(`  ${String(f).padStart(5)} Hz  ${e.gainsDb[k] >= 0 ? '+' : ''}${e.gainsDb[k]} dB`));
        }
        break;
      }
      case 'watch':
        for (const ev of ['sidetone', 'volume', 'balance', 'sleep', 'tones', 'noiseGate', 'routing', 'equalizer', 'battery', 'settingsChecksum']) {
          dev.on(ev, (v) => console.log(new Date().toISOString(), ev, JSON.stringify(v)));
        }
        console.log('watching device events (Ctrl-C to stop)');
        await new Promise(() => undefined);
        break;
      default:
        throw new Error(`unknown command "${cmd}"\n${USAGE}`);
    }
  } finally {
    dev.close();
  }
}
