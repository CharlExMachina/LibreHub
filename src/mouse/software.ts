// The G Hub features that need the computer: actions it performs when you press a button
// (open an app, file or URL; run a command) and Freestyle per-LED lighting. Like G Hub, these
// live on the computer, in a small JSON file next to the app's other settings, and only work
// while the app or `g502x agent` runs (see agent.ts). Everything else, macros included, is
// stored on the mouse.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { G502X_CONTROLS, type Binding, type ControlId, type MacroStep } from './onboard.js';
import { DOUBLE_CLICK, parseMacro, textToSteps } from './macros.js';
import { parseBinding } from './usages.js';

export type SoftwareAction =
  /** Open an app, file or URL the way the desktop would (macOS `open`, Linux `xdg-open`). */
  | { type: 'open'; target: string }
  /** Run a shell command. */
  | { type: 'run'; command: string };

/** What a control can be set to: something the mouse stores, a macro it plays, or a computer action. */
export type Assignment =
  | { kind: 'binding'; binding: Binding }
  | { kind: 'macro'; steps: MacroStep[] }
  | { kind: 'software'; action: SoftwareAction };

export type Layer = 'base' | 'gshift';

/**
 * Parse the text form of an assignment: the binding syntax (usages.ts), the macro syntax
 * (macros.ts: text:…, double-click, macro:…), or open:<app|file|url> and run:<command>.
 */
export function parseAssignment(input: string): Assignment {
  const text = input.trim();
  const m = text.match(/^([a-z-]+):(.*)$/is);
  const kind = (m?.[1] ?? text).toLowerCase();
  const rest = m?.[2] ?? '';
  switch (kind) {
    case 'text':
      return { kind: 'macro', steps: textToSteps(rest) };
    case 'double-click':
      return { kind: 'macro', steps: DOUBLE_CLICK.map((s) => ({ ...s })) };
    case 'macro':
      return { kind: 'macro', steps: parseMacro(rest) };
    case 'open':
      if (!rest.trim()) throw new Error('open needs an app, file or URL, e.g. open:/Applications/Calculator.app or open:https://example.com');
      return { kind: 'software', action: { type: 'open', target: rest.trim() } };
    case 'run':
      if (!rest.trim()) throw new Error('run needs a command, e.g. run:firefox');
      return { kind: 'software', action: { type: 'run', command: rest.trim() } };
    default:
      return { kind: 'binding', binding: parseBinding(text) };
  }
}

export function formatSoftwareAction(a: SoftwareAction): string {
  return a.type === 'open' ? `open:${a.target}` : `run:${a.command}`;
}

// ------------------------------------------------------------------ Freestyle

/**
 * The eight LEDs, left to right as G Hub draws them on the mouse (G Hub's light_map.json maps its
 * Freestyle dots to these LED numbers; x/y are on G Hub's 1391x2700 picture). The strip is Y
 * shaped: six LEDs along the curve, and the right end forks into an upper and a lower LED.
 */
export const FREESTYLE_LEDS = [
  { led: 3, where: 'strip, left end', x: 430, y: 1900 },
  { led: 4, where: 'strip, 2nd from left', x: 570, y: 2110 },
  { led: 8, where: 'strip, 3rd from left', x: 640, y: 2150 },
  { led: 7, where: 'strip, middle', x: 820, y: 2140 },
  { led: 6, where: 'strip, right of middle', x: 990, y: 2180 },
  { led: 5, where: 'strip, before the fork', x: 1120, y: 2090 },
  { led: 2, where: 'right side, upper', x: 1210, y: 2000 },
  { led: 1, where: 'right side, lower', x: 1270, y: 2210 },
] as const;

export type Rgb = [number, number, number];
/** LED number (1..8) → colour. */
export type Freestyle = Record<string, string>;

const HEX = /^#?([0-9a-f]{6})$/i;

export function parseColor(text: string): string {
  const m = text.trim().match(HEX);
  if (!m) throw new Error(`colour must be #rrggbb, got "${text}"`);
  return `#${m[1].toLowerCase()}`;
}

export const rgbOf = (hex: string): Rgb => {
  const v = parseInt(parseColor(hex).slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
};

/** "off", one colour for all LEDs, or eight colours left to right (FREESTYLE_LEDS order). */
export function parseFreestyle(text: string): Freestyle | null {
  if (text.trim().toLowerCase() === 'off') return null;
  const colors = text.split(',').map(parseColor);
  if (colors.length !== 1 && colors.length !== FREESTYLE_LEDS.length) {
    throw new Error(`give one colour, or ${FREESTYLE_LEDS.length} colours left to right, or "off"; got ${colors.length}`);
  }
  return Object.fromEntries(FREESTYLE_LEDS.map((l, i) => [String(l.led), colors.length === 1 ? colors[0] : colors[i]]));
}

export const formatFreestyle = (f: Freestyle | null): string => (f ? FREESTYLE_LEDS.map((l) => f[String(l.led)] ?? '#000000').join(',') : 'off');

// ------------------------------------------------------------------ the settings file

export interface ProfileSoftware {
  actions: Record<Layer, Partial<Record<ControlId, SoftwareAction>>>;
  freestyle: Freestyle | null;
}

export interface SoftwareConfig {
  version: 1;
  /** Keyed by onboard profile slot, "1".."5". */
  profiles: Record<string, ProfileSoftware>;
}

const empty = (): ProfileSoftware => ({ actions: { base: {}, gshift: {} }, freestyle: null });

export function profileSoftware(c: SoftwareConfig, slot: number): ProfileSoftware {
  const p = c.profiles[String(slot)];
  return p ? { actions: { base: { ...p.actions?.base }, gshift: { ...p.actions?.gshift } }, freestyle: p.freestyle ?? null } : empty();
}

/** Where the app and the CLI keep these settings (the same folder as the A50 X presets). */
export function defaultSoftwareFile(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.G502X_CONFIG) return env.G502X_CONFIG;
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'logitech-manager', 'g502x.json')
    : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'logitech-manager', 'g502x.json');
}

const CONTROL_IDS = new Set<string>(G502X_CONTROLS.map((c) => c.id));

function validAction(a: unknown): a is SoftwareAction {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (x.type === 'open' && typeof x.target === 'string' && !!x.target) || (x.type === 'run' && typeof x.command === 'string' && !!x.command);
}

/** Drop anything malformed rather than act on it (the file is hand-editable). */
function sanitize(raw: unknown): SoftwareConfig {
  const out: SoftwareConfig = { version: 1, profiles: {} };
  const profiles = (raw as { profiles?: Record<string, unknown> })?.profiles;
  if (!profiles || typeof profiles !== 'object') return out;
  for (const [slot, p] of Object.entries(profiles)) {
    if (!/^[1-5]$/.test(slot) || !p || typeof p !== 'object') continue;
    const ps = empty();
    const actions = (p as { actions?: Record<string, Record<string, unknown>> }).actions ?? {};
    for (const layer of ['base', 'gshift'] as const) {
      for (const [control, a] of Object.entries(actions[layer] ?? {})) {
        if (CONTROL_IDS.has(control) && validAction(a)) ps.actions[layer][control as ControlId] = a;
      }
    }
    const fs = (p as { freestyle?: unknown }).freestyle;
    if (fs && typeof fs === 'object') {
      const leds = Object.entries(fs as Record<string, unknown>).filter(([led, c]) => /^[1-8]$/.test(led) && typeof c === 'string' && HEX.test(c));
      if (leds.length) ps.freestyle = Object.fromEntries(leds.map(([led, c]) => [led, parseColor(c as string)]));
    }
    out.profiles[slot] = ps;
  }
  return out;
}

export class SoftwareStore {
  /** Read-modify-write operations run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = defaultSoftwareFile()) {}

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read(): Promise<SoftwareConfig> {
    return this.exclusive(() => this.load());
  }

  private async load(): Promise<SoftwareConfig> {
    try {
      return sanitize(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
      if (err instanceof SyntaxError) throw new Error(`${this.file} is not valid JSON: ${err.message}`);
      throw err;
    }
  }

  /** Change one profile's software settings and save (atomically: write a temp file, rename). */
  update(slot: number, change: (p: ProfileSoftware) => void): Promise<void> {
    return this.exclusive(async () => {
      const c = await this.load();
      const p = profileSoftware(c, slot);
      change(p);
      const used = Object.values(p.actions.base).length + Object.values(p.actions.gshift).length > 0 || p.freestyle;
      if (used) c.profiles[String(slot)] = p;
      else delete c.profiles[String(slot)];
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(c, null, 2) + '\n');
      await rename(tmp, this.file);
    });
  }
}
