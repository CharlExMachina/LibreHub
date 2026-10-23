// Macros the mouse runs by itself. The firmware executes the onboard macro format (onboard.ts,
// MacroStep) from its own flash: a binding points at a sector and offset, and the mouse plays the
// steps as keyboard and mouse input, with no software running. G Hub never uses this on the
// G502 X PLUS (it plays macros from the computer), but the firmware does: a G9 binding pointing
// at "h, i" typed "hi" into a text field (docs/evidence/g502x/lab/lab.txt, test 3).
//
// Text syntax, used by the CLI and the app:
//
//   text:Hello, World!       types the text (US keyboard layout; printable ASCII only)
//   double-click             two left clicks
//   macro:ctrl+c, 50ms, ctrl+v, enter, mouse:left, media:mute, down:shift, up:shift, wheel:-3
//
// Each profile keeps its macros in two sectors of its own (6+7 for profile 1 ... 14+15 for
// profile 5), so editing one profile never touches another profile's macros. A single macro
// has to fit in one sector (253 bytes, about 40 characters of text).

import { decodeMacro, encodeMacro, MouseButton, Modifier, withCrc, type MacroStep } from './onboard.js';
import { KEYS, MEDIA, parseKeySpec, formatKeySpec } from './usages.js';

/** Sectors that hold a profile's macros. */
export function macroSectorsFor(profile: number): [number, number] {
  if (!Number.isInteger(profile) || profile < 1 || profile > 5) throw new RangeError(`profile must be 1..5, got ${profile}`);
  return [4 + 2 * profile, 5 + 2 * profile];
}

// ------------------------------------------------------------------ text (US layout)

const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: 'minus', '+': 'equal', '{': 'leftbracket', '}': 'rightbracket', '|': 'backslash', ':': 'semicolon',
  '"': 'quote', '~': 'grave', '<': 'comma', '>': 'period', '?': 'slash',
};
const PLAIN: Record<string, string> = {
  ' ': 'space', '-': 'minus', '=': 'equal', '[': 'leftbracket', ']': 'rightbracket', '\\': 'backslash',
  ';': 'semicolon', "'": 'quote', '`': 'grave', ',': 'comma', '.': 'period', '/': 'slash', '\n': 'enter', '\t': 'tab',
};

/** The key (and whether Shift is needed) that types a character on a US layout. */
export function keyForChar(ch: string): { usage: number; shift: boolean } {
  if (/^[a-z0-9]$/.test(ch)) return { usage: KEYS[ch], shift: false };
  if (/^[A-Z]$/.test(ch)) return { usage: KEYS[ch.toLowerCase()], shift: true };
  if (PLAIN[ch]) return { usage: KEYS[PLAIN[ch]], shift: false };
  if (SHIFTED[ch]) return { usage: KEYS[SHIFTED[ch]], shift: true };
  throw new RangeError(`cannot type "${ch}": the mouse sends key presses, so text is limited to printable ASCII (US layout)`);
}

const charOf = (usage: number, shift: boolean): string | undefined => {
  for (let c = 32; c < 127; c++) {
    const ch = String.fromCharCode(c);
    const k = keyForChar(ch);
    if (k.usage === usage && k.shift === shift) return ch;
  }
  if (!shift && usage === KEYS.enter) return '\n';
  if (!shift && usage === KEYS.tab) return '\t';
  return undefined;
};

const tap = (modifiers: number, usage: number): MacroStep[] => [
  { op: 'key-down', modifiers, usage },
  { op: 'key-up', modifiers, usage },
];

export function textToSteps(text: string): MacroStep[] {
  if (!text) throw new RangeError('text is empty');
  return [...text].flatMap((ch) => {
    const k = keyForChar(ch);
    return tap(k.shift ? Modifier.lshift : 0, k.usage);
  });
}

export const DOUBLE_CLICK: MacroStep[] = [
  { op: 'buttons-down', buttons: MouseButton.left },
  { op: 'buttons-up', buttons: MouseButton.left },
  { op: 'delay', ms: 30 },
  { op: 'buttons-down', buttons: MouseButton.left },
  { op: 'buttons-up', buttons: MouseButton.left },
];

// ------------------------------------------------------------------ macro step syntax

const MOUSE_WORDS: Record<string, number> = { ...MouseButton };
const mouseBit = (name: string) => {
  const bit = MOUSE_WORDS[name] ?? (/^\d+$/.test(name) && +name >= 1 && +name <= 16 ? 1 << (+name - 1) : undefined);
  if (bit === undefined) throw new RangeError(`unknown mouse button "${name}" (left, right, middle, back, forward, 1..16)`);
  return bit;
};
const mouseName = (bit: number) => Object.entries(MOUSE_WORDS).find(([, b]) => b === bit)?.[0] ?? String(Math.log2(bit) + 1);

function parseStep(raw: string): MacroStep[] {
  const s = raw.trim().toLowerCase();
  if (!s) throw new RangeError('empty macro step (two commas in a row?)');
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+)\s*ms$/)) || (m = s.match(/^delay:(\d+)$/))) {
    const ms = +m[1];
    if (ms < 1 || ms > 0xffff) throw new RangeError(`delay must be 1..65535 ms, got ${ms}`);
    return [{ op: 'delay', ms }];
  }
  if ((m = s.match(/^(down|up):(.+)$/))) {
    const [, dir, what] = m;
    const mouse = what.match(/^mouse:(.+)$/);
    if (mouse) return [{ op: dir === 'down' ? 'buttons-down' : 'buttons-up', buttons: mouseBit(mouse[1]) }];
    const k = parseKeySpec(what);
    return [{ op: dir === 'down' ? 'key-down' : 'key-up', ...k }];
  }
  if ((m = s.match(/^mouse:(.+)$/))) {
    const buttons = m[1].split('+').reduce((acc, b) => acc | mouseBit(b), 0);
    return [{ op: 'buttons-down', buttons }, { op: 'buttons-up', buttons }];
  }
  if ((m = s.match(/^media:(.+)$/))) {
    const usage = MEDIA[m[1]] ?? (/^0x[0-9a-f]{1,4}$/.test(m[1]) ? parseInt(m[1], 16) : undefined);
    if (usage === undefined) throw new RangeError(`unknown media key "${m[1]}" (${Object.keys(MEDIA).join(', ')})`);
    return [{ op: 'consumer-down', usage }, { op: 'consumer-up', usage }];
  }
  if ((m = s.match(/^(h?wheel):([+-]?\d+)$/))) {
    const delta = +m[2];
    if (delta < -128 || delta > 127 || delta === 0) throw new RangeError(`wheel steps must be -128..127 and not 0, got ${delta}`);
    return [{ op: m[1] === 'wheel' ? 'wheel' : 'hwheel', delta }];
  }
  const k = parseKeySpec(s.replace(/^key:/, ''));
  return tap(k.modifiers, k.usage);
}

/** Parse "ctrl+c, 50ms, ctrl+v" into macro steps. */
export function parseMacro(text: string): MacroStep[] {
  const steps = text.split(',').flatMap(parseStep);
  if (!steps.length) throw new RangeError('macro has no steps');
  return steps;
}

/** Show steps the way they would be typed: text:…, double-click, or macro:…. */
export function formatMacro(steps: MacroStep[]): string {
  if (steps.length === DOUBLE_CLICK.length && steps.every((s, i) => JSON.stringify(s) === JSON.stringify(DOUBLE_CLICK[i]))) return 'double-click';
  const text = asText(steps);
  if (text !== undefined) return `text:${text}`;
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    switch (s.op) {
      case 'key-down':
        if (next?.op === 'key-up' && next.usage === s.usage && next.modifiers === s.modifiers) {
          out.push(formatKeySpec(s.modifiers, s.usage));
          i++;
        } else out.push(`down:${formatKeySpec(s.modifiers, s.usage)}`);
        break;
      case 'key-up':
        out.push(`up:${formatKeySpec(s.modifiers, s.usage)}`);
        break;
      case 'buttons-down':
        if (next?.op === 'buttons-up' && next.buttons === s.buttons) {
          out.push(`mouse:${bits(s.buttons).map(mouseName).join('+')}`);
          i++;
        } else out.push(`down:mouse:${mouseName(s.buttons)}`);
        break;
      case 'buttons-up':
        out.push(`up:mouse:${mouseName(s.buttons)}`);
        break;
      case 'consumer-down':
      case 'consumer-up': {
        const name = Object.entries(MEDIA).find(([, u]) => u === s.usage)?.[0] ?? `0x${s.usage.toString(16).padStart(4, '0')}`;
        if (s.op === 'consumer-down' && next?.op === 'consumer-up' && next.usage === s.usage) {
          out.push(`media:${name}`);
          i++;
        } else out.push(`${s.op === 'consumer-down' ? 'down' : 'up'}:media:${name}`);
        break;
      }
      case 'delay':
        out.push(`${s.ms}ms`);
        break;
      case 'wheel':
      case 'hwheel':
        out.push(`${s.op}:${s.delta}`);
        break;
      default:
        out.push(s.op);
    }
  }
  return `macro:${out.join(', ')}`;
}

const bits = (mask: number) => Array.from({ length: 16 }, (_, b) => 1 << b).filter((b) => mask & b);

/** The text a macro types, if it is nothing but key taps of printable characters. */
function asText(steps: MacroStep[]): string | undefined {
  if (steps.length < 2 || steps.length % 2) return undefined;
  let text = '';
  for (let i = 0; i < steps.length; i += 2) {
    const [d, u] = [steps[i], steps[i + 1]];
    if (d.op !== 'key-down' || u.op !== 'key-up' || d.usage !== u.usage || d.modifiers !== u.modifiers) return undefined;
    if (d.modifiers !== 0 && d.modifiers !== Modifier.lshift) return undefined;
    const ch = charOf(d.usage, d.modifiers === Modifier.lshift);
    if (ch === undefined || ch === '\n' || ch === '\t') return undefined;
    text += ch;
  }
  return text;
}

// ------------------------------------------------------------------ packing into sectors

export interface PackedMacros {
  /** Full sector images (padded with FF and checksummed), one per sector given. */
  sectors: Map<number, Uint8Array>;
  /** Where each macro landed, in input order. */
  pointers: { sector: number; offset: number }[];
}

/** Place macros first-fit into the given sectors. Throws if one is too big or they don't fit. */
export function packMacros(macros: MacroStep[][], sectorIds: number[], size: number): PackedMacros {
  const room = size - 2; // the CRC takes the last two bytes
  const fill = new Map(sectorIds.map((s) => [s, [] as number[]]));
  const pointers = macros.map((steps, i) => {
    const bytes = encodeMacro(steps);
    if (bytes.length > room) throw new RangeError(`macro ${i + 1} is ${bytes.length} bytes; one macro can use at most ${room} (about ${Math.floor((room - 1) / 6)} characters of text)`);
    const sector = sectorIds.find((s) => fill.get(s)!.length + bytes.length <= room);
    if (sector === undefined) throw new RangeError(`this profile's macros need more than the ${sectorIds.length * room} bytes it has on the mouse; shorten or remove one`);
    const at = fill.get(sector)!;
    const offset = at.length;
    at.push(...bytes);
    return { sector, offset };
  });
  const sectors = new Map<number, Uint8Array>();
  for (const [s, bytes] of fill) {
    const img = new Uint8Array(size).fill(0xff);
    img.set(bytes, 0);
    sectors.set(s, withCrc(img));
  }
  return { sectors, pointers };
}

/** Read a macro from a sector image; undefined if the bytes there are not a valid macro. */
export function readMacro(sector: ArrayLike<number> | undefined, offset: number): MacroStep[] | undefined {
  if (!sector) return undefined;
  try {
    const steps = decodeMacro(sector, offset);
    return steps.length ? steps : undefined;
  } catch {
    return undefined;
  }
}
