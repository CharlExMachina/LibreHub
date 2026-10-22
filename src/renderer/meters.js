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

/** The last few seconds of mic level, newest on the right; silent stretches are shaded. */
export function levelTrace({ seconds = 6, fps = 30, label }) {
  const n = seconds * fps;
  const canvas = el('canvas', { class: 'trace-canvas', 'aria-hidden': 'true' });
  const grid = el('div', { class: 'trace-grid', 'aria-hidden': 'true' },
    ...[-20, -40, -60].map((db) => el('span', { 'data-db': `−${-db} dB`, style: { top: `${(1 - frac(db)) * 100}%` } })));
  const node = el('div', { class: 'trace', role: 'img', 'aria-label': label }, canvas, grid);
  const levels = new Float32Array(n).fill(FLOOR_DB);
  const silent = new Uint8Array(n);
  let head = 0;
  let count = 0;
  let quiet = 0;
  let skipped = 0;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let colors = null;
  let w = 0;
  let h = 0;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    w = Math.round(r.width * dpr);
    h = Math.round(r.height * dpr);
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    draw();
  };
  new ResizeObserver(resize).observe(canvas);

  let pattern = null;
  const stripes = () => {
    if (pattern) return pattern;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(8 * dpr);
    const tile = new OffscreenCanvas(size, size);
    const t = tile.getContext('2d');
    t.strokeStyle = 'rgb(255 255 255 / 0.12)';
    t.lineWidth = dpr;
    t.beginPath();
    for (const o of [-size, 0, size]) { t.moveTo(o, size); t.lineTo(o + size, 0); }
    t.stroke();
    pattern = ctx.createPattern(tile, 'repeat');
    return pattern;
  };

  function draw() {
    if (!w || !h) return;
    colors ??= (() => {
      const css = getComputedStyle(document.documentElement);
      return { accent: css.getPropertyValue('--accent').trim(), warn: css.getPropertyValue('--warn').trim(), danger: css.getPropertyValue('--danger').trim() };
    })();
    ctx.clearRect(0, 0, w, h);
    const col = w / n;
    const gap = Math.min(col * 0.35, 2 * (window.devicePixelRatio || 1));
    // Stripe runs of silence first, then draw the level bars on top.
    ctx.fillStyle = stripes();
    for (let i = 0; i < count; ) {
      const at = (j) => (head - count + j + n) % n;
      if (!silent[at(i)]) { i++; continue; }
      let j = i;
      while (j < count && silent[at(j)]) j++;
      const x0 = w - (count - i) * col;
      ctx.fillRect(x0, 0, (j - i) * col, h);
      i = j;
    }
    for (let i = 0; i < count; i++) {
      const k = (head - count + i + n) % n;
      if (silent[k] || levels[k] <= FLOOR_DB) continue;
      const db = levels[k];
      const bh = Math.max(1, frac(db) * h);
      ctx.fillStyle = db > -1 ? colors.danger : db > -6 ? colors.warn : colors.accent;
      ctx.globalAlpha = 0.35 + 0.65 * ((i + n - count) / n);
      ctx.fillRect(w - (count - i) * col + gap / 2, h - bh, col - gap, bh);
    }
    ctx.globalAlpha = 1;
  }

  return {
    el: node,
    push(db, isSilent) {
      const unchanged = isSilent && count === n && quiet >= n;
      levels[head] = db;
      silent[head] = isSilent ? 1 : 0;
      head = (head + 1) % n;
      count = Math.min(n, count + 1);
      quiet = isSilent ? quiet + 1 : 0;
      // A trace that's silent end to end looks the same next frame: don't redraw it. With reduced
      // motion, it moves in steps a few times a second instead of scrolling smoothly.
      if (!unchanged && (!calm.matches || ++skipped % 8 === 0)) draw();
    },
    clear() {
      count = 0;
      quiet = 0;
      draw();
    },
  };
}
