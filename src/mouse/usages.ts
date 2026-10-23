// Human-readable names for the HID usages a binding can send, and a small text syntax for
// bindings so the CLI and the app can show and accept them:
//
//   mouse:left | mouse:right | mouse:middle | mouse:back | mouse:forward | mouse:6..16
//   key:ctrl+shift+t     (modifiers: ctrl shift alt gui, left side; rctrl rshift ralt rgui)
//   media:volume-up      (consumer control; or media:0x00e9)
//   fn:dpi-shift         (firmware functions, see ButtonFunction)
//   disabled             (does nothing; G Hub's "Disable")
//   default              (unassigned: the control keeps its native behaviour)

import { ButtonFunction, Modifier, MouseButton, type Binding, type ButtonFunctionName } from './onboard.js';

/** HID keyboard usages (usage page 0x07). */
export const KEYS: Record<string, number> = (() => {
  const k: Record<string, number> = {};
  for (let i = 0; i < 26; i++) k[String.fromCharCode(97 + i)] = 0x04 + i;
  for (let i = 1; i <= 9; i++) k[String(i)] = 0x1d + i;
  k['0'] = 0x27;
  Object.assign(k, {
    enter: 0x28, escape: 0x29, backspace: 0x2a, tab: 0x2b, space: 0x2c, minus: 0x2d, equal: 0x2e,
    leftbracket: 0x2f, rightbracket: 0x30, backslash: 0x31, semicolon: 0x33, quote: 0x34, grave: 0x35,
    comma: 0x36, period: 0x37, slash: 0x38, capslock: 0x39, printscreen: 0x46, scrolllock: 0x47,
    pause: 0x48, insert: 0x49, home: 0x4a, pageup: 0x4b, delete: 0x4c, end: 0x4d, pagedown: 0x4e,
    right: 0x4f, left: 0x50, down: 0x51, up: 0x52, numlock: 0x53, 'kp-divide': 0x54, 'kp-multiply': 0x55,
    'kp-minus': 0x56, 'kp-plus': 0x57, 'kp-enter': 0x58, menu: 0x65,
  });
  for (let i = 1; i <= 12; i++) k[`f${i}`] = 0x39 + i;
  for (let i = 13; i <= 24; i++) k[`f${i}`] = 0x68 + (i - 13);
  for (let i = 1; i <= 9; i++) k[`kp-${i}`] = 0x58 + i;
  k['kp-0'] = 0x62;
  return k;
})();

/** Consumer-control usages (usage page 0x0C) that G Hub offers. */
export const MEDIA: Record<string, number> = {
  'next-track': 0xb5, 'previous-track': 0xb6, stop: 0xb7, 'play-pause': 0xcd, mute: 0xe2,
  'volume-up': 0xe9, 'volume-down': 0xea, 'brightness-up': 0x6f, 'brightness-down': 0x70,
  calculator: 0x192, 'file-browser': 0x194, 'web-home': 0x223, 'web-back': 0x224, 'web-forward': 0x225,
  'web-refresh': 0x227, 'web-search': 0x221, mail: 0x18a,
};

const MODIFIER_WORDS: Record<string, number> = {
  ctrl: Modifier.lctrl, shift: Modifier.lshift, alt: Modifier.lalt, gui: Modifier.lgui, cmd: Modifier.lgui, super: Modifier.lgui,
  rctrl: Modifier.rctrl, rshift: Modifier.rshift, ralt: Modifier.ralt, rgui: Modifier.rgui,
};
const MODIFIER_NAMES: [number, string][] = [
  [Modifier.lctrl, 'ctrl'], [Modifier.lshift, 'shift'], [Modifier.lalt, 'alt'], [Modifier.lgui, 'gui'],
  [Modifier.rctrl, 'rctrl'], [Modifier.rshift, 'rshift'], [Modifier.ralt, 'ralt'], [Modifier.rgui, 'rgui'],
];

const nameOf = (table: Record<string, number>, v: number) => Object.entries(table).find(([, n]) => n === v)?.[0];
const MOUSE_NAMES: Record<string, number> = { ...MouseButton };

/** "ctrl+shift+t" → modifiers and HID usage; modifiers alone ("shift") have usage 0. */
export function parseKeySpec(spec: string): { modifiers: number; usage: number } {
  const parts = spec.trim().toLowerCase().split('+').filter(Boolean);
  if (parts.length && parts.every((m) => MODIFIER_WORDS[m] !== undefined)) {
    return { modifiers: parts.reduce((acc, m) => acc | MODIFIER_WORDS[m], 0), usage: 0 };
  }
  const key = parts.pop();
  if (!key) throw new Error('a key is needed, e.g. key:ctrl+c');
  let modifiers = 0;
  for (const m of parts) {
    if (MODIFIER_WORDS[m] === undefined) throw new Error(`unknown modifier "${m}" (${Object.keys(MODIFIER_WORDS).join(', ')})`);
    modifiers |= MODIFIER_WORDS[m];
  }
  const usage = KEYS[key] ?? (/^0x[0-9a-f]{1,2}$/.test(key) ? parseInt(key, 16) : undefined);
  if (usage === undefined) throw new Error(`unknown key "${key}"`);
  return { modifiers, usage };
}

export function formatKeySpec(modifiers: number, usage: number): string {
  const mods = MODIFIER_NAMES.filter(([bit]) => modifiers & bit).map(([, n]) => n);
  if (usage === 0 && mods.length) return mods.join('+');
  const key = nameOf(KEYS, usage) ?? `0x${usage.toString(16).padStart(2, '0')}`;
  return [...mods, key].join('+');
}

export function formatBinding(b: Binding): string {
  switch (b.type) {
    case 'unassigned':
      return 'default';
    case 'disabled':
      return 'disabled';
    case 'mouse': {
      const names = [];
      for (let bit = 0; bit < 16; bit++) {
        if (b.buttons & (1 << bit)) names.push(nameOf(MOUSE_NAMES, 1 << bit) ?? String(bit + 1));
      }
      return `mouse:${names.join('+') || 'none'}`;
    }
    case 'key':
      return `key:${formatKeySpec(b.modifiers, b.usage)}`;
    case 'consumer':
      return `media:${nameOf(MEDIA, b.usage) ?? `0x${b.usage.toString(16).padStart(4, '0')}`}`;
    case 'function':
      return `fn:${b.fn}`;
    case 'software-only':
      return 'software-only';
    case 'macro':
      return `macro:${b.sector}:${b.offset}`;
    case 'raw':
      return `raw:${b.bytes.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
}

export function parseBinding(text: string): Binding {
  const t = text.trim().toLowerCase();
  if (t === 'default' || t === 'unassigned') return { type: 'unassigned' };
  if (t === 'disabled' || t === 'disable' || t === 'none') return { type: 'disabled' };
  const [kind, rest = ''] = t.split(/:(.*)/s);
  switch (kind) {
    case 'mouse': {
      let buttons = 0;
      for (const part of rest.split('+')) {
        const bit = MOUSE_NAMES[part] ?? (/^\d+$/.test(part) && +part >= 1 && +part <= 16 ? 1 << (+part - 1) : undefined);
        if (bit === undefined) throw new Error(`unknown mouse button "${part}" (left, right, middle, back, forward, 1..16)`);
        buttons |= bit;
      }
      return { type: 'mouse', buttons };
    }
    case 'key':
      return { type: 'key', ...parseKeySpec(rest) };
    case 'media': {
      const usage = MEDIA[rest] ?? (/^0x[0-9a-f]{1,4}$/.test(rest) ? parseInt(rest, 16) : undefined);
      if (usage === undefined) throw new Error(`unknown media key "${rest}" (${Object.keys(MEDIA).join(', ')})`);
      return { type: 'consumer', usage };
    }
    case 'fn': {
      if (!(rest in ButtonFunction)) throw new Error(`unknown function "${rest}" (${Object.keys(ButtonFunction).join(', ')})`);
      return { type: 'function', fn: rest as ButtonFunctionName };
    }
    default:
      throw new Error(`cannot parse binding "${text}" (mouse:…, key:…, media:…, fn:…, disabled, default)`);
  }
}
