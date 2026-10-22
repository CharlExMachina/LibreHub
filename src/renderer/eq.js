// Interactive 10-band EQ: a smooth response curve on a log-frequency axis with one draggable node per band.
// Drag a node (or drag anywhere in a band's column), or focus the graph and use the arrow keys.
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const HEIGHT = 250;
const PAD = { l: 44, r: 12, t: 16, b: 12 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const fmtFreq = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : String(f));
export const fmtGain = (g) => (Math.abs(g) < 0.05 ? '0.0' : `${g > 0 ? '+' : '−'}${Math.abs(g).toFixed(1)}`);

/** Frequency range shown for a band set: a little room either side of the outer bands. */
export const freqRange = (freqs) => [freqs[0] / 1.22, freqs[freqs.length - 1] * 1.22];

/** Monotone cubic interpolation (Fritsch–Carlson): smooth, never overshoots between bands. */
export function monotone(xs, ys) {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];
  const d = [];
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export function eqGraph({ id, label, onInput, onCommit }) {
  let freqs = [];
  let gains = [];
  let shown = [];
  let gainMin = -6;
  let gainMax = 6;
  let fLo = 20;
  let fHi = 20000;
  let width = 800;
  let active = -1;
  let focusIdx = 0;
  let dragging = false;
  let lastKey = -Infinity;
  let anim = 0;
  let commitTimer;
  let ghostGains = null;
  let deferred = null;

  const root = el('div', { class: 'eq' });
  const s = svg('svg', { height: HEIGHT, role: 'group', 'aria-label': label });
  const defs = svg('defs');
  const grad = svg('linearGradient', { id: `${id}-fill`, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0 });
  defs.append(grad);
  const gridG = svg('g', { class: 'grid' });
  const ghost = svg('path', { class: 'ghost' });
  const area = svg('path', { class: 'area', fill: `url(#${id}-fill)` });
  const curve = svg('path', { class: 'curve' });
  const nodesG = svg('g');
  s.append(defs, gridG, ghost, area, curve, nodesG);
  const tip = el('div', { class: 'tip' });
  const bandsRow = el('div', { class: 'eq-bands' });
  root.append(s, tip, bandsRow);

  const plotW = () => width - PAD.l - PAD.r;
  const plotH = HEIGHT - PAD.t - PAD.b;
  const x = (f) => PAD.l + ((Math.log10(f) - Math.log10(fLo)) / (Math.log10(fHi) - Math.log10(fLo))) * plotW();
  const y = (g) => PAD.t + ((gainMax - g) / (gainMax - gainMin)) * plotH;
  const gAt = (py) => gainMax - ((py - PAD.t) / plotH) * (gainMax - gainMin);
  const clamp = (g) => Math.min(gainMax, Math.max(gainMin, g));
  const snap = (g, fine) => Math.round(g / (fine ? 0.1 : 0.5)) * (fine ? 0.1 : 0.5);

  function drawGrid() {
    gridG.replaceChildren();
    // Fill fades toward the 0 dB line: mint above it, blue below.
    grad.setAttribute('y1', String(PAD.t));
    grad.setAttribute('y2', String(PAD.t + plotH));
    const zeroPct = ((y(0) - PAD.t) / plotH) * 100;
    grad.replaceChildren(
      svg('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': 0.42 }),
      svg('stop', { offset: `${zeroPct}%`, 'stop-color': 'var(--accent)', 'stop-opacity': 0.04 }),
      svg('stop', { offset: `${zeroPct}%`, 'stop-color': 'var(--neg)', 'stop-opacity': 0.04 }),
      svg('stop', { offset: '100%', 'stop-color': 'var(--neg)', 'stop-opacity': 0.36 }));
    const step = gainMax - gainMin >= 12 ? 3 : 1;
    for (let g = gainMin; g <= gainMax + 1e-9; g += step) {
      gridG.append(svg('line', { x1: PAD.l, x2: width - PAD.r, y1: y(g), y2: y(g), class: g === 0 ? 'zero' : '' }));
      const t = svg('text', { x: PAD.l - 10, y: y(g) + 4, 'text-anchor': 'end', class: 'axis' });
      t.textContent = g === 0 ? '0 dB' : `${g > 0 ? '+' : '−'}${Math.abs(g)}`;
      gridG.append(t);
    }
    for (const f of freqs) gridG.append(svg('line', { x1: x(f), x2: x(f), y1: PAD.t, y2: PAD.t + plotH, class: 'band-line' }));
  }

  function pathFor(values) {
    const fn = monotone(freqs.map((f) => Math.log10(f)), values);
    const lo = Math.log10(fLo), hi = Math.log10(fHi);
    let d = '';
    for (let i = 0; i <= 240; i++) {
      const l = lo + ((hi - lo) * i) / 240;
      d += `${i ? 'L' : 'M'}${x(10 ** l).toFixed(1)} ${y(fn(l)).toFixed(1)}`;
    }
    return d;
  }

  function drawCurve() {
    if (!freqs.length) return;
    const d = pathFor(shown);
    curve.setAttribute('d', d);
    area.setAttribute('d', `${d}L${x(fHi)} ${y(0)}L${x(fLo)} ${y(0)}Z`);
    ghost.setAttribute('d', ghostGains ? pathFor(ghostGains) : '');
    nodesG.querySelectorAll('.node').forEach((n, i) => n.setAttribute('transform', `translate(${x(freqs[i])} ${y(shown[i])})`));
  }

  function drawBands() {
    bandsRow.replaceChildren(...freqs.map((f, i) => {
      const g = shown[i];
      return el('div', { style: { left: `${x(f)}px` } },
        el('div', { class: `g ${g > 0.05 ? 'pos' : g < -0.05 ? 'neg' : ''}` }, fmtGain(g)),
        el('div', { class: 'f' }, fmtFreq(f)));
    }));
  }

  function buildNodes() {
    nodesG.replaceChildren(...freqs.map((f, i) => {
      const n = svg('g', { class: 'node', tabindex: i === focusIdx ? 0 : -1, role: 'slider', 'aria-label': `${fmtFreq(f)}Hz band`,
        'aria-orientation': 'vertical' });
      n.append(svg('circle', { class: 'hit', r: 16 }), svg('circle', { class: 'ring', r: 7 }), svg('circle', { class: 'core', r: 2.5 }));
      n.addEventListener('pointerdown', (e) => startDrag(e, i, true));
      n.addEventListener('dblclick', () => { setBand(i, 0); onCommit([...gains]); });
      n.addEventListener('focus', () => { active = i; setFocusIdx(i); showTip(i); });
      n.addEventListener('blur', () => { if (!dragging) { active = -1; hideTip(); } });
      n.addEventListener('mouseenter', () => !dragging && showTip(i));
      n.addEventListener('mouseleave', () => !dragging && document.activeElement !== n && hideTip());
      n.addEventListener('keydown', (e) => onKey(e, i));
      return n;
    }));
  }

  // One Tab stop for the whole graph; arrow keys move between bands.
  function setFocusIdx(i) {
    focusIdx = i;
    nodesG.querySelectorAll('.node').forEach((n, k) => (n.tabIndex = k === i ? 0 : -1));
  }

  function setAria() {
    nodesG.querySelectorAll('.node').forEach((n, i) => {
      n.setAttribute('aria-valuemin', String(gainMin));
      n.setAttribute('aria-valuemax', String(gainMax));
      n.setAttribute('aria-valuenow', String(gains[i]));
      n.setAttribute('aria-valuetext', `${fmtGain(gains[i])} dB at ${fmtFreq(freqs[i])}Hz`);
    });
  }

  function render() {
    drawCurve();
    drawBands();
    setAria();
    if (active >= 0) showTip(active);
  }

  function showTip(i) {
    tip.innerHTML = `${fmtFreq(freqs[i])} Hz&nbsp;&nbsp;<b class="${shown[i] < -0.05 ? 'neg' : ''}">${fmtGain(shown[i])} dB</b>`;
    tip.style.left = `${x(freqs[i])}px`;
    tip.style.top = `${y(shown[i])}px`;
    tip.classList.add('show');
    nodesG.querySelectorAll('.node').forEach((n, k) => n.classList.toggle('active', k === i));
  }
  function hideTip() {
    tip.classList.remove('show');
    nodesG.querySelectorAll('.node').forEach((n) => n.classList.remove('active'));
  }

  function setBand(i, g) {
    cancelAnimationFrame(anim);
    gains[i] = Math.round(clamp(g) * 100) / 100;
    shown = [...gains];
    render();
    onInput([...gains]);
  }

  const pointerGain = (e) => gAt(e.clientY - s.getBoundingClientRect().top);

  /** Node drags move right away; drags that start in empty plot space only move after 4 px, so a stray click changes nothing. */
  function startDrag(e, i, onNode) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    active = i;
    setFocusIdx(i);
    nodesG.children[i].focus({ preventScroll: true });
    s.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    let moving = onNode;
    dragging = true;
    const move = (ev) => {
      if (!moving && Math.abs(ev.clientY - y0) < 4) return;
      moving = true;
      setBand(i, snap(pointerGain(ev), ev.shiftKey));
    };
    const up = () => {
      dragging = false;
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', up);
      s.removeEventListener('pointercancel', up);
      if (moving) onCommit([...gains]);
      flush();
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
    showTip(i);
  }

  s.addEventListener('pointerdown', (e) => {
    if (!freqs.length) return;
    const px = e.clientX - s.getBoundingClientRect().left;
    let best = 0;
    freqs.forEach((f, i) => { if (Math.abs(x(f) - px) < Math.abs(x(freqs[best]) - px)) best = i; });
    startDrag(e, best, false);
  });

  function onKey(e, i) {
    const step = e.shiftKey ? 0.1 : 0.5;
    let g = gains[i];
    switch (e.key) {
      case 'ArrowUp': g += step; break;
      case 'ArrowDown': g -= step; break;
      case 'PageUp': g += 3; break;
      case 'PageDown': g -= 3; break;
      case 'Home': g = gainMax; break;
      case 'End': g = gainMin; break;
      case '0': case 'Delete': case 'Backspace': g = 0; break;
      case 'ArrowRight': case 'ArrowLeft': {
        e.preventDefault();
        const next = nodesG.children[i + (e.key === 'ArrowRight' ? 1 : -1)];
        next?.focus();
        return;
      }
      default: return;
    }
    e.preventDefault();
    lastKey = performance.now();
    setBand(i, Math.round(g * 10) / 10);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => onCommit([...gains]), 400);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 850);
  }

  // A device update that arrived mid-edit is shown once the user stops.
  let flushTimer;
  function flush() {
    if (!deferred || dragging || performance.now() - lastKey < 800) return;
    const args = deferred;
    deferred = null;
    api.set(...args);
  }

  new ResizeObserver(() => {
    const w = Math.round(root.clientWidth);
    if (!w || w === width) return;
    width = w;
    s.setAttribute('width', String(width));
    s.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    drawGrid();
    render();
  }).observe(root);

  const api = {
    el: root,
    get gains() { return [...gains]; },
    /** Dashed outline of another curve (e.g. the preset the user started from), or null. */
    setGhost(values) {
      ghostGains = values && values.length === freqs.length ? [...values] : null;
      drawCurve();
    },
    /** Show the device's EQ; animates between curves. Ignored while the user is editing. */
    set(nextFreqs, nextGains, range = {}) {
      if (dragging || performance.now() - lastKey < 800) {
        deferred = [nextFreqs, nextGains, range];
        return;
      }
      deferred = null;
      const nextMin = range.min ?? gainMin;
      const nextMax = range.max ?? gainMax;
      const reshape = nextFreqs.join() !== freqs.join() || nextMin !== gainMin || nextMax !== gainMax;
      freqs = [...nextFreqs];
      gains = [...nextGains];
      if (reshape) {
        gainMin = nextMin;
        gainMax = nextMax;
        [fLo, fHi] = freqRange(freqs);
        shown = [...gains];
        focusIdx = Math.min(focusIdx, freqs.length - 1);
        buildNodes();
        drawGrid();
        render();
        return;
      }
      const from = [...shown];
      if (from.every((g, i) => Math.abs(g - gains[i]) < 0.01)) return;
      cancelAnimationFrame(anim);
      if (reducedMotion.matches) {
        shown = [...gains];
        render();
        return;
      }
      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / 260);
        const k = 1 - (1 - t) ** 3;
        shown = from.map((g, i) => g + (gains[i] - g) * k);
        render();
        if (t < 1) anim = requestAnimationFrame(tick);
      };
      anim = requestAnimationFrame(tick);
    },
  };
  return api;
}

/** Small static preview of an EQ curve (SVG markup) for summary cards. */
export function miniCurve(id, freqs, gains, { width = 320, height = 96, gainMin = -6, gainMax = 6 } = {}) {
  const [fLo, fHi] = freqRange(freqs);
  const lo = Math.log10(fLo), hi = Math.log10(fHi);
  const x = (l) => ((l - lo) / (hi - lo)) * width;
  const y = (g) => 6 + ((gainMax - g) / (gainMax - gainMin)) * (height - 12);
  const fn = monotone(freqs.map((f) => Math.log10(f)), gains);
  let d = '';
  for (let i = 0; i <= 120; i++) {
    const l = lo + ((hi - lo) * i) / 120;
    d += `${i ? 'L' : 'M'}${x(l).toFixed(1)} ${y(fn(l)).toFixed(1)}`;
  }
  const ticks = freqs.map((f) => `<line class="tick" x1="${x(Math.log10(f)).toFixed(1)}" x2="${x(Math.log10(f)).toFixed(1)}" y1="0" y2="${height}"/>`).join('');
  return `<svg class="mini-curve" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="6" y2="${height - 6}">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".4"/><stop offset=".5" stop-color="var(--accent)" stop-opacity=".04"/>
      <stop offset=".5" stop-color="var(--neg)" stop-opacity=".04"/><stop offset="1" stop-color="var(--neg)" stop-opacity=".34"/></linearGradient></defs>
    ${ticks}
    <line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <path d="${d}L${width} ${y(0)}L0 ${y(0)}Z" fill="url(#${id})"/>
    <path d="${d}" class="line"/>
  </svg>`;
}
