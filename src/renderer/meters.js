// Live level meters. The main process reads the levels (src/audio/meters.ts); these only draw them.
import { el } from './ui.js';

/** Meters show -70..0 dBFS: the mic's room noise (about -60 with the gate off) still shows. */
export const FLOOR_DB = -70;
/**
 * Below this the signal is digital silence. Measured on an A50 X: a closed noise gate sends
 * ±1 LSB of 16-bit audio (-90.3 dBFS), the room noise with the gate off sits near -60 dBFS.
 */
const SILENCE_DB = -80;
/** Silence for this many frames (about 100 ms) counts as the gate being closed. */
const SILENT_FRAMES = 3;

const frac = (db) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
export const dbText = (db) => {
  if (db <= SILENCE_DB) return 'Silence';
  const n = Math.round(db);
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n)} dB`;
};

/**
 * A thin vertical peak meter with a peak-hold marker. Only transforms change from frame to frame, so
 * the compositor moves them without repainting: the cover hides the unlit part of the lit gradient.
 */
export function levelBar({ label, description, className = '' }) {
  const cover = el('div', { class: 'lvl-cover' });
  const hold = el('div', { class: 'lvl-hold' });
  const node = el('div', { class: `lvl ${className}`.trim(), role: 'meter', 'aria-label': label, title: description, 'aria-description': description,
    'aria-valuemin': String(FLOOR_DB), 'aria-valuemax': '0' },
  el('div', { class: 'lvl-fill' }), cover, hold, el('div', { class: 'lvl-segs' }));
  let spoken = 0;
  let drawn = '';
  const api = {
    el: node,
    set(level, peak) {
      // Unchanged at the meter's resolution: skip, so silence costs no frames.
      const f = Math.round(frac(level) * 400) / 400;
      const h = Math.round(frac(peak) * 400) / 400;
      const sig = `${f}|${h}|${peak > -1}`;
      if (sig !== drawn) {
        drawn = sig;
        cover.style.transform = `scaleY(${1 - f})`;
        hold.style.transform = `translateY(calc(${-h * 100}% + 2px))`;
        hold.classList.toggle('on', h > 0);
        hold.classList.toggle('clip', peak > -1);
      }
      // Screen readers get the value a few times a second, not 30.
      const now = performance.now();
      if (now - spoken > 250) {
        spoken = now;
        node.setAttribute('aria-valuenow', String(Math.round(Math.max(level, FLOOR_DB))));
        node.setAttribute('aria-valuetext', dbText(level));
      }
    },
    clear() {
      api.set(FLOOR_DB, FLOOR_DB);
      spoken = 0;
      node.setAttribute('aria-valuenow', String(FLOOR_DB));
      node.setAttribute('aria-valuetext', 'Not measuring');
    },
  };
  api.clear();
  return api;
}

/** Tells an open gate from a closed one by the silence a closed gate sends. */
export function gateWatch() {
  let silent = 0;
  return {
    /** Feed one frame's raw peak; returns true while the mic sends silence. */
    push(peakDb) {
      silent = peakDb <= SILENCE_DB ? silent + 1 : 0;
      return silent >= SILENT_FRAMES;
    },
    reset() { silent = 0; },
  };
}

/** Dots in a ledMeter: about 2 dB each over FLOOR_DB..0. */
const LEDS = 36;
/** The dB marks under a ledMeter. */
const LED_MARKS = [-60, -40, -20, -6, 0];

/**
 * A horizontal meter of dots, lit from the left up to the level, with the peak marker as one dimmer dot.
 * Each dot keeps its colour (mint, amber from -6 dB, red from -1 dB); a frame only flips the dots whose
 * state changed, so silence or a steady level costs nothing.
 */
export function ledMeter({ label }) {
  // Dot i covers the 2 dB below top(i), lights from its middle up, and takes its colour from its top.
  const top = (i) => FLOOR_DB + ((i + 1) / LEDS) * -FLOOR_DB;
  const dots = Array.from({ length: LEDS }, (_, i) => el('span', { class: top(i) > -1 ? 'danger' : top(i) > -6 ? 'warn' : '' }));
  // Each mark sits under the dot whose range holds it.
  const marks = LED_MARKS.map((db) => el('span', { style: { gridColumn: String(Math.max(1, Math.ceil(frac(db) * LEDS))) } }, db ? `−${-db}` : '0'));
  const node = el('div', { class: 'led', role: 'meter', 'aria-label': label, 'aria-valuemin': String(FLOOR_DB), 'aria-valuemax': '0' },
    el('div', { class: 'led-dots' }, dots), el('div', { class: 'led-marks', 'aria-hidden': 'true' }, marks));
  let lit = 0;
  let held = -1;
  let spoken = 0;
  const api = {
    el: node,
    /** level and peak in dBFS; silent: the mic sends silence, which leaves every dot dark. */
    set(level, peak, silent = false) {
      const n = silent ? 0 : Math.round(frac(level) * LEDS);
      const h = silent ? -1 : Math.round(frac(peak) * LEDS) - 1;
      for (let i = Math.min(n, lit); i < Math.max(n, lit); i++) dots[i].classList.toggle('on', i < n);
      if (h !== held) {
        if (held >= 0) dots[held].classList.remove('hold');
        if (h >= n) dots[h].classList.add('hold');
      } else if (h >= 0) dots[h].classList.toggle('hold', h >= n);
      lit = n;
      held = h;
      // Screen readers get the value a few times a second, not 30.
      const now = performance.now();
      if (now - spoken > 250) {
        spoken = now;
        node.setAttribute('aria-valuenow', String(Math.round(silent ? FLOOR_DB : Math.max(level, FLOOR_DB))));
        node.setAttribute('aria-valuetext', silent ? 'Silence' : dbText(level));
      }
    },
    clear() {
      api.set(FLOOR_DB, FLOOR_DB, true);
      spoken = 0;
      node.setAttribute('aria-valuenow', String(FLOOR_DB));
      node.setAttribute('aria-valuetext', 'Not measuring');
    },
  };
  api.clear();
  return api;
}
