// Small DOM toolkit: element builder, device write queue, toasts and the shared controls.
import { icon } from './icons.js';

/** el('div', { class: 'x', onclick }, child, 'text', [more]) — `html` sets innerHTML (trusted markup only). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--x) only take effect through setProperty.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export const iconEl = (name, size) => el('span', { class: 'icon-wrap', style: { display: 'contents' }, html: icon(name, size) });

// ------------------------------------------------------------------ device writes

/**
 * Sends actions to a device, one at a time per control ("key"). By default only the newest value
 * waits while a write is in flight, so dragging a slider streams changes at the device's pace without
 * a backlog. Discrete actions (saving or deleting presets) pass `{ coalesce: false }` so none is lost.
 * `send` resolves with the main process's answer for that action ({ superseded } / { dropped } if it never ran).
 */
export function createWriter(onResult, apply = (action) => window.a50x.apply(action)) {
  const keys = new Map();
  let epoch = 0;
  const slot = (key) => keys.get(key) ?? keys.set(key, { busy: false, queue: [], touched: 0 }).get(key);

  async function run(key) {
    const s = slot(key);
    const job = s.queue.shift();
    s.busy = true;
    const mine = epoch;
    let res;
    try {
      res = await apply(job.action);
    } catch (err) {
      res = { connected: true, error: String(err?.message ?? err) };
    }
    if (mine !== epoch) return job.resolve({ dropped: true });
    const more = s.queue.length > 0;
    if (!more) {
      // The last write's snapshot is the device's answer: let it through to the control.
      s.busy = false;
      s.touched = 0;
    }
    job.resolve(res);
    onResult(res, { key, settled: !more });
    if (more) void run(key);
  }

  return {
    send(key, action, { coalesce = true } = {}) {
      return new Promise((resolve) => {
        const s = slot(key);
        s.touched = performance.now();
        if (coalesce) {
          for (const j of s.queue) j.resolve({ superseded: true });
          s.queue = [];
        }
        s.queue.push({ action, resolve });
        if (!s.busy) void run(key);
      });
    },
    /** Forget everything queued (the device went away); answers to writes already sent are ignored. */
    reset() {
      epoch++;
      for (const s of keys.values()) {
        for (const j of s.queue) j.resolve({ dropped: true });
        s.queue = [];
        s.busy = false;
        s.touched = 0;
      }
    },
    /** True while a control's own writes are pending, so device reports from before them don't snap it back. */
    quiet(key) {
      const s = keys.get(key);
      return !!s && (s.busy || performance.now() - s.touched < 150);
    },
    get idle() {
      for (const s of keys.values()) if (s.busy) return false;
      return true;
    },
  };
}

// ------------------------------------------------------------------ toasts

export function toast(message, { kind = 'info', action, timeout = 4200 } = {}) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { html: icon(kind === 'error' ? 'alert' : 'check', 18), style: { display: 'contents' } }),
    el('div', { class: 'msg' }, message),
    action ? el('button', { class: 'btn sm', onclick: () => { action.run(); close(); } }, action.label) : null,
    el('button', { class: 'btn ghost sm', 'aria-label': 'Dismiss', onclick: () => close(), html: icon('x', 16) }));
  if (action) node.dataset.action = '1';
  let timer;
  function close() {
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }
  host.append(node);
  // The host is a popover so toasts show above an open modal dialog (both live in the top layer;
  // the one shown last is on top).
  if (host.matches(':popover-open')) host.hidePopover();
  host.showPopover();
  // Keep at most three; never drop one that still offers an action (e.g. Undo).
  for (const old of [...host.children]) {
    if (host.children.length <= 3) break;
    if (old !== node && !old.dataset.action) old.remove();
  }
  if (timeout) {
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, timeout); };
    const hold = () => clearTimeout(timer);
    arm();
    node.addEventListener('mouseenter', hold);
    node.addEventListener('mouseleave', () => { if (!node.contains(document.activeElement)) arm(); });
    node.addEventListener('focusin', hold);
    node.addEventListener('focusout', (e) => { if (!node.contains(e.relatedTarget)) arm(); });
  }
  return close;
}

// ------------------------------------------------------------------ controls

/**
 * A slider bound to a device setting. `onChange(value)` runs on every change; `onCommit(value)` only
 * when the user lets go (or per key press), for settings that shouldn't be written while dragging.
 * The device's value is shown again only when the user isn't holding the slider and its writes have settled.
 */
export function slider({ min, max, step = 1, label, className = 'range', quiet, onChange, onCommit, onPreview, valueText }) {
  const input = el('input', { type: 'range', class: className, min, max, step, 'aria-label': label });
  let held = false;
  let lastKey = -Infinity;
  let deferred;
  let timer;
  const paint = () => {
    const lo = Number(input.min), hi = Number(input.max);
    input.style.setProperty('--pct', `${((Number(input.value) - lo) / (hi - lo || 1)) * 100}%`);
    if (valueText) input.setAttribute('aria-valuetext', valueText(Number(input.value)));
    onPreview?.(Number(input.value));
  };
  const busy = () => held || performance.now() - lastKey < 600 || quiet?.();
  // A device value that arrived while the user was busy is shown once they let go.
  const flush = () => {
    if (deferred === undefined || busy()) return;
    const v = deferred;
    deferred = undefined;
    api.set(v);
  };
  // Before the listeners below: the user's value replaces any device value that arrived meanwhile.
  // From the keyboard each key press is a change; those are sent once the keys pause.
  let commitTimer = 0;
  const commit = () => { clearTimeout(commitTimer); commitTimer = 0; onCommit(Number(input.value)); };
  if (onCommit) {
    input.addEventListener('change', () => {
      deferred = undefined;
      clearTimeout(commitTimer);
      if (performance.now() - lastKey < 600) commitTimer = setTimeout(commit, 450);
      else commit();
    });
    input.addEventListener('blur', () => { if (commitTimer) commit(); });
  }
  input.addEventListener('pointerdown', () => (held = true));
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'change']) input.addEventListener(ev, () => { held = false; flush(); });
  input.addEventListener('blur', () => { lastKey = -Infinity; flush(); });
  input.addEventListener('keydown', () => {
    lastKey = performance.now();
    clearTimeout(timer);
    timer = setTimeout(flush, 650);
  });
  input.addEventListener('input', () => {
    paint();
    onChange?.(Number(input.value));
  });
  const api = {
    el: input,
    set(value) {
      if (busy()) {
        deferred = value;
        return;
      }
      deferred = undefined;
      if (Number(input.value) !== value) input.value = String(value);
      paint();
    },
  };
  return api;
}

/** Radio group drawn as a segmented control. options: [{ value, label }] */
export function segmented({ label, options, onChange, full = false }) {
  const buttons = options.map((o) =>
    el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-value': String(o.value), tabindex: '-1',
      onclick: () => pick(o.value, true) }, o.label));
  const root = el('div', { class: `segmented${full ? ' full' : ''}`, role: 'radiogroup', 'aria-label': label }, buttons);
  let current;
  function pick(value, fromUser) {
    current = value;
    for (const b of buttons) {
      const on = b.dataset.value === String(value);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (fromUser) onChange(value);
  }
  root.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = options.findIndex((o) => String(o.value) === String(current));
    const next = options[(i + dir + options.length) % options.length];
    pick(next.value, true);
    buttons[options.indexOf(next)].focus();
  });
  return { el: root, set: (v) => pick(v, false) };
}

/**
 * A drop-down, in place of <select>, whose list the system draws itself (plain grey on Linux). A field
 * shows the choice; its menu is glass that grows out of the field, as iOS's pop-up menus do. It's a
 * popover, so it shows over anything that clips the field. groups: [{ label?, options: [{ value, label,
 * title? }] }]. `placeholder` is what the field says when the value is none of the options.
 */
export function dropdown({ label, groups = [], onChange, placeholder = '' }) {
  const text = el('span', { class: 'dd-text' });
  const field = el('button', { type: 'button', class: 'field sm dd-field', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label },
    text, el('span', { class: 'dd-chevron', html: icon('chevron', 14) }));
  const menu = el('div', { class: 'dd-menu', role: 'listbox', 'aria-label': label, tabindex: '-1', popover: 'manual' });
  let value = null;
  let items = [];
  let active = -1;
  let open = false;

  function paint() {
    const opt = groups.flatMap((g) => g.options).find((o) => String(o.value) === String(value));
    text.textContent = opt?.label ?? placeholder;
    field.title = opt?.title ?? '';
  }
  function build() {
    items = [];
    menu.replaceChildren(...groups.map((g) => el('div', { role: 'group', 'aria-label': g.label },
      g.label ? el('div', { class: 'dd-group', 'aria-hidden': 'true' }, g.label) : null,
      g.options.map((o) => {
        const item = el('div', { class: 'dd-item', role: 'option', title: o.title, 'aria-selected': String(String(o.value) === String(value)),
          onclick: () => pick(o.value) }, el('span', { class: 'dd-check', html: icon('check', 14) }), el('span', {}, o.label));
        item.addEventListener('pointermove', () => highlight(items.indexOf(item)));
        items.push(item);
        return item;
      }))));
  }
  function highlight(i) {
    active = i;
    items.forEach((it, j) => it.classList.toggle('active', j === i));
    items[i]?.scrollIntoView({ block: 'nearest' });
  }
  // Below the field, or above it where there's no room; at least as wide as the field.
  function place() {
    const r = field.getBoundingClientRect();
    menu.style.minWidth = `${r.width}px`;
    const h = menu.offsetHeight;
    const below = innerHeight - r.bottom - 12;
    const up = below < h && r.top - 12 > below;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${up ? Math.max(8, r.top - 6 - h) : r.bottom + 6}px`;
    menu.style.transformOrigin = `${Math.min(r.width / 2, menu.offsetWidth / 2)}px ${up ? '100%' : '0'}`;
  }
  function show() {
    if (open) return;
    open = true;
    build();
    document.body.append(menu);
    menu.showPopover();
    place();
    field.setAttribute('aria-expanded', 'true');
    highlight(Math.max(0, items.findIndex((it) => it.getAttribute('aria-selected') === 'true')));
    menu.focus({ preventScroll: true });
    menu.classList.remove('leaving');
    menu.classList.add('opening');
    addEventListener('pointerdown', outside, true);
    addEventListener('resize', hide);
    addEventListener('blur', hide);
    document.addEventListener('scroll', scrolled, true);
  }
  function hide({ refocus = false } = {}) {
    if (!open) return;
    open = false;
    field.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
    removeEventListener('resize', hide);
    removeEventListener('blur', hide);
    document.removeEventListener('scroll', scrolled, true);
    if (refocus) field.focus({ preventScroll: true });
    menu.classList.remove('opening');
    menu.classList.add('leaving');
    setTimeout(() => { if (!open) { menu.hidePopover(); menu.remove(); } }, 160);
  }
  function outside(e) {
    if (!menu.contains(e.target) && !field.contains(e.target)) hide();
  }
  // The page scrolling would leave the menu behind; the menu's own list scrolling is fine.
  function scrolled(e) {
    if (!menu.contains(e.target)) hide();
  }
  function pick(v) {
    const changed = String(v) !== String(value);
    value = v;
    paint();
    hide({ refocus: true });
    if (changed) onChange(v);
  }

  field.addEventListener('click', () => (open ? hide() : show()));
  field.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
  });
  menu.addEventListener('keydown', (e) => {
    const n = items.length;
    if (e.key === 'ArrowDown') highlight((active + 1) % n);
    else if (e.key === 'ArrowUp') highlight((active - 1 + n) % n);
    else if (e.key === 'Home') highlight(0);
    else if (e.key === 'End') highlight(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') items[active]?.click();
    else if (e.key === 'Escape') hide({ refocus: true });
    else if (e.key === 'Tab') return hide({ refocus: true });
    else return;
    e.preventDefault();
  });

  return {
    el: field,
    get value() { return value; },
    set(v) { value = v; paint(); if (open) build(); },
    setGroups(next) { groups = next; paint(); if (open) { build(); place(); } },
  };
}

/** Bigger radio cards with an icon and a description. options: [{ value, label, desc, icon }] */
export function choiceCards({ label, options, onChange }) {
  const cards = options.map((o) =>
    el('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': 'false', 'data-value': o.value, tabindex: '-1',
      onclick: () => pick(o.value, true) },
      el('span', { style: { display: 'contents' }, html: icon(o.icon, 20) }),
      el('span', { class: 'tick', html: icon('check', 12) }),
      el('b', {}, o.label),
      el('span', {}, o.desc)));
  const root = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': label }, cards);
  let current;
  function pick(value, fromUser) {
    current = value;
    for (const c of cards) {
      const on = c.dataset.value === value;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
    if (fromUser) onChange(value);
  }
  root.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === current);
    const next = options[(i + dir + options.length) % options.length];
    pick(next.value, true);
    cards[options.indexOf(next)].focus();
  });
  return { el: root, set: (v) => pick(v, false) };
}

/** On/off switch. Label it with `label`, or aria-labelledby on `.el`. */
export function toggle({ label, onChange }) {
  const btn = el('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-label': label });
  let on = false;
  const paint = () => btn.setAttribute('aria-checked', String(on));
  btn.addEventListener('click', () => {
    on = !on;
    paint();
    onChange(on);
  });
  return { el: btn, set(v) { on = !!v; paint(); } };
}

/** Mute toggle button. */
export function muteButton({ label, onChange }) {
  const btn = el('button', { type: 'button', class: 'icon-btn mute', 'aria-pressed': 'false', 'aria-label': label, title: label });
  let muted = false;
  const paint = () => {
    btn.setAttribute('aria-pressed', String(muted));
    btn.innerHTML = icon(muted ? 'volumeOff' : 'volume', 18);
    btn.title = muted ? `Unmute ${label.replace(/^Mute /, '')}` : label;
  };
  btn.addEventListener('click', () => {
    muted = !muted;
    paint();
    onChange(muted);
  });
  paint();
  return { el: btn, set(v) { if (v !== muted) { muted = v; paint(); } }, get muted() { return muted; } };
}

/** Modal text prompt. Resolves with the trimmed text, or null when cancelled. */
export function prompt({ title, body, label = 'Name', placeholder, initial = '', confirm = 'Save', validate, maxlength = 24 }) {
  return new Promise((resolve) => {
    const uid = `dlg${Math.random().toString(36).slice(2, 8)}`;
    const input = el('input', { class: 'field', id: `${uid}-in`, type: 'text', placeholder, value: initial, maxlength, spellcheck: 'false',
      'aria-describedby': `${uid}-hint` });
    const hint = el('div', { class: 'field-hint', id: `${uid}-hint`, 'aria-live': 'polite' });
    const ok = el('button', { class: 'btn primary', type: 'submit' }, confirm);
    const dlg = el('dialog', { 'aria-labelledby': `${uid}-t` },
      el('form', { method: 'dialog' },
        el('h2', { id: `${uid}-t` }, title), body ? el('p', {}, body) : null,
        el('label', { class: 'field-label', for: `${uid}-in` }, label), input, hint,
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close('') }, 'Cancel'), ok)));
    const check = () => {
      const res = validate?.(input.value.trim());
      hint.textContent = res?.hint ?? '';
      ok.textContent = res?.confirm ?? confirm;
      ok.disabled = !input.value.trim() || !!res?.block;
    };
    input.addEventListener('input', check);
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim() && !ok.disabled) dlg.close(input.value.trim());
    });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue || null);
      dlg.remove();
    });
    document.body.append(dlg);
    check();
    dlg.showModal();
    input.select();
  });
}

/** A yes/no question. Resolves true when confirmed. */
export function confirmDialog({ title, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { 'aria-labelledby': 'confirm-t' },
      el('form', { method: 'dialog' },
        el('h2', { id: 'confirm-t' }, title), el('p', {}, body),
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close('') }, 'Cancel'),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, value: 'yes' }, confirm))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Commands to copy, with a copy button. */
export function codeBlock(text) {
  const done = el('span', { class: 'sr-only', role: 'status' });
  const btn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy commands', title: 'Copy', html: icon('copy', 16) });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.innerHTML = icon('check', 16);
      done.textContent = 'Copied';
    } catch {
      done.textContent = 'Couldn’t copy. Select the text instead.';
    }
    setTimeout(() => { btn.innerHTML = icon('copy', 16); done.textContent = ''; }, 1500);
  });
  return el('div', { class: 'code' }, el('pre', {}, text), btn, done);
}
