// `librehub camera`: command-line control for the Logitech MX Brio. Same code path as the app.

import { MxBrio } from './mxbrio.js';
import { CameraService, type CameraAction, type CameraSnapshot, type PresetGroup } from './service.js';
import { formatSetting, GROUP_KEYS, parseSetting, SETTINGS, SETTING_KEYS, type CameraSettings, type Group, type SettingKey } from './settings.js';
import { CameraStore, defaultCameraFile } from './store.js';
import { openCamera, type CameraTransport } from './transport.js';

const GROUP_TITLES: Record<Group, string> = { crop: 'Crop', exposure: 'Exposure', image: 'Image', focus: 'Focus', general: 'General' };

const USAGE = `usage: librehub camera <command>
  status [--json]                 settings, microphone, presets, and what is kept
  set <setting> <value> [<setting> <value> …]
                                  write settings to the camera (and keep them; see below)
  reset [crop|exposure|image|focus|all]
                                  G Hub's "Reset to default" for one tab (default: all)
  preset <crop|exposure|image|focus> <name>
                                  apply one of G Hub's presets, or one of yours
  preset save <group> <name>      save the group's current settings as a preset
  preset delete <group> <name>
  microphone <on|off>             the camera's microphones (it restarts to apply this)
  restore                         put the kept settings back where the camera differs
  forget                          stop keeping settings for this camera
  settings                        list settings and their values

Settings you change are saved in ${defaultCameraFile()}
and put back when the camera connects (the app does this; or run "librehub camera restore"):
the camera forgets its framing when it restarts, as G Hub knows.

examples:
  librehub camera set fov 78 zoom 150
  librehub camera set auto-exposure off shutter 1/120 iso 400
  librehub camera preset image "Black and White"`;

/** "auto-exposure" and "autoExposure" both name the same setting. */
function settingKey(name: string): SettingKey {
  const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as SettingKey;
  if (!(key in SETTINGS)) throw new Error(`unknown setting "${name}"; "librehub camera settings" lists them`);
  return key;
}
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function presetGroup(g: string | undefined): PresetGroup {
  if (g === 'crop' || g === 'exposure' || g === 'image' || g === 'focus') return g;
  throw new Error('preset group must be crop, exposure, image or focus');
}

export function printStatus(s: CameraSnapshot): void {
  console.log(`${s.device.model}  serial ${s.device.serial}  firmware ${s.device.firmware}`);
  console.log(`Microphone: ${s.microphone ? 'on' : 'off'}`);
  for (const group of ['crop', 'exposure', 'image', 'focus', 'general'] as Group[]) {
    const presets = s.presets.filter((p) => p.group === group);
    const match = presets.find((p) => p.matches);
    console.log(`\n${GROUP_TITLES[group]}${presets.length ? `  (preset: ${match?.name ?? 'custom'})` : ''}`);
    for (const k of GROUP_KEYS[group]) {
      const auto = SETTINGS[k].auto ?? SETTINGS[k].manualWith;
      const idle = auto && s.settings[auto] === true ? '  (auto)' : '';
      console.log(`  ${kebab(k).padEnd(26)}${formatSetting(k, s.settings[k])}${idle}`);
    }
  }
  const kept = Object.keys(s.saved);
  console.log(`\nKept and put back on connect: ${kept.length ? kept.map(kebab).join(', ') : 'nothing yet'}`);
}

function printSettings(): void {
  for (const k of SETTING_KEYS) {
    const s = SETTINGS[k];
    const range = s.kind === 'boolean' ? 'on | off' : s.kind === 'choice' ? s.choices!.map((c) => (k === 'shutter' ? `1/${c}` : c)).join(' | ') : `${s.min}..${s.max}${s.step! > 1 ? ` step ${s.step}` : ''}`;
    console.log(`  ${kebab(k).padEnd(26)}${range}${k === 'pan' || k === 'tilt' ? '  (arc seconds, or degrees -20..20)' : ''}`);
  }
}

export async function readCameraStatus(open: () => Promise<CameraTransport> = () => openCamera()): Promise<CameraSnapshot> {
  const camera = new MxBrio(await open());
  try {
    return await new CameraService(camera, new CameraStore()).snapshot();
  } finally {
    camera.close();
  }
}

export async function runCli(raw: string[], open: () => Promise<CameraTransport> = () => openCamera()): Promise<void> {
  const json = raw.includes('--json');
  const [cmd, ...args] = raw.filter((a) => a !== '--json');
  if (!cmd || cmd === 'help' || cmd === '--help') return void console.log(USAGE);
  if (cmd === 'settings' && !args.length) {
    printSettings();
    return;
  }
  const camera = new MxBrio(await open());
  const svc = new CameraService(camera, new CameraStore());
  const apply = (a: CameraAction) => svc.apply(a);
  try {
    switch (cmd) {
      case 'status': {
        const s = await svc.snapshot();
        if (json) console.log(JSON.stringify(s, null, 2));
        else printStatus(s);
        return;
      }
      case 'set': {
        if (!args.length || args.length % 2) throw new Error('set takes pairs: <setting> <value>');
        const settings: Partial<Record<SettingKey, unknown>> = {};
        for (let i = 0; i < args.length; i += 2) {
          const key = settingKey(args[i]);
          settings[key] = parseSetting(key, args[i + 1]);
        }
        return await apply({ type: 'set', settings: settings as Partial<CameraSettings> });
      }
      case 'reset': {
        const group = (args[0] ?? 'all') as Group | 'all';
        if (group !== 'all' && !(group in GROUP_KEYS)) throw new Error('reset takes crop, exposure, image, focus, general or all');
        return await apply({ type: 'reset', group });
      }
      case 'preset':
        if (args[0] === 'save') return await apply({ type: 'savePreset', group: presetGroup(args[1]), name: args.slice(2).join(' ') });
        if (args[0] === 'delete') return await apply({ type: 'deletePreset', group: presetGroup(args[1]), name: args.slice(2).join(' ') });
        return await apply({ type: 'preset', group: presetGroup(args[0]), name: args.slice(1).join(' ') });
      case 'microphone':
        if (args[0] !== 'on' && args[0] !== 'off') throw new Error('expected on or off');
        await apply({ type: 'microphone', enabled: args[0] === 'on' });
        console.log(`The camera restarts with its microphones ${args[0]}.`);
        return;
      case 'restore': {
        const changed = await svc.restore();
        const keys = Object.keys(changed) as SettingKey[];
        console.log(keys.length ? `put back: ${keys.map((k) => `${kebab(k)} ${formatSetting(k, changed[k]!)}`).join(', ')}` : 'the camera already has the kept settings');
        return;
      }
      case 'forget':
        return await apply({ type: 'forget' });
      default:
        throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } finally {
    camera.close();
  }
}
