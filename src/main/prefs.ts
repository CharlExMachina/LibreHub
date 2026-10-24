// App preferences (not headset settings): notifications, keeping the headset's settings and the appearance.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Prefs {
  /** Check the headset against the saved settings and put back anything that changed. */
  keepSettings: boolean;
  /** Desktop notification when a check had to restore something. */
  notifyRestores: boolean;
  /** The one-time "still running in the tray" notice has been shown. */
  trayHintShown: boolean;
  /** Light or dark, or whatever the system uses. */
  theme: Theme;
  /** Liquid glass that lets the content through, or a more opaque one with more contrast. */
  glass: Glass;
}

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
export type Glass = 'clear' | 'tinted';
export const GLASSES: readonly Glass[] = ['clear', 'tinted'];

export const DEFAULT_PREFS: Prefs = {
  keepSettings: false,
  notifyRestores: true,
  trayHintShown: false,
  theme: 'system',
  glass: 'clear',
};

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Fill in defaults and drop anything unknown, so a hand-edited or older file still loads. */
export function normalize(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    keepSettings: bool(r.keepSettings, DEFAULT_PREFS.keepSettings),
    notifyRestores: bool(r.notifyRestores, DEFAULT_PREFS.notifyRestores),
    trayHintShown: bool(r.trayHintShown, DEFAULT_PREFS.trayHintShown),
    theme: THEMES.includes(r.theme as Theme) ? (r.theme as Theme) : DEFAULT_PREFS.theme,
    glass: GLASSES.includes(r.glass as Glass) ? (r.glass as Glass) : DEFAULT_PREFS.glass,
  };
}

export function loadPrefs(file: string): Prefs {
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return normalize({});
  }
}

export function savePrefs(file: string, prefs: Prefs): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  renameSync(tmp, file);
}
