// G502 X PLUS control panel. Like the headset's (app.js), pages are built once and then updated in
// place from snapshots. Almost every setting lives in one of the mouse's five onboard profiles, and
// each change rewrites that profile in the mouse's flash memory: sliders and number fields write
// when you let go, never while you drag. Software actions and Freestyle live on this computer.
import { mouseArt } from './art.js';
import { icon } from './icons.js';
import { appCard } from './prefs.js';
import { accessScreen } from './access.js';
import { confirmDialog, createWriter, el, prompt, segmented, slider, toast, toggle } from './ui.js';

const ic = (name, size) => el('span', { style: { display: 'contents' }, html: icon(name, size) });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const isMac = window.a50x?.platform === 'darwin';

export const MOUSE_PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'sensitivity', label: 'Sensitivity', icon: 'gauge' },
  { id: 'buttons', label: 'Buttons', icon: 'mouse' },
  { id: 'lighting', label: 'Lighting', icon: 'bulb' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** G Hub writes this placeholder as the name of a profile you never named. */
const profileName = (p) => (p.name && p.name !== 'PROFILE_NAME_DEFAULT' ? p.name : `Profile ${p.slot}`);
const minutes = (s) => (s === null ? 'Never' : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

// ------------------------------------------------------------------ controls and assignments

/** The mouse's controls by onboard id (src/mouse/onboard.ts), named by where they are. */
const CONTROLS = {
  left: { name: 'Left button' },
  right: { name: 'Right button' },
  middle: { name: 'Wheel click' },
  back: { name: 'Rear thumb button', where: 'Back by default' },
  sniper: { name: 'Sniper button', where: 'Front thumb button' },
  forward: { name: 'Middle thumb button', where: 'Forward by default' },
  'tilt-left': { name: 'Wheel tilt left' },
  'tilt-right': { name: 'Wheel tilt right' },
  g9: { name: 'Button behind the wheel' },
  'dpi-up': { name: 'Upper left button', where: 'Printed G8, next to the left button' },
  'dpi-down': { name: 'Lower left button', where: 'Printed G7, next to the left button' },
  'wheel-down': { name: 'Wheel down' },
  'wheel-up': { name: 'Wheel up' },
};

const MOUSE_BUTTONS = { left: 'Left click', right: 'Right click', middle: 'Middle click', back: 'Back', forward: 'Forward' };
const FUNCTIONS = {
  'dpi-up': 'DPI up', 'dpi-down': 'DPI down', 'dpi-cycle': 'Cycle DPI levels', 'dpi-default': 'Default DPI level', 'dpi-shift': 'DPI shift (hold)',
  'profile-next': 'Next profile', 'profile-previous': 'Previous profile', 'profile-cycle': 'Cycle profiles',
  'g-shift': 'G-Shift (hold)', 'battery-status': 'Show battery level',
  'wheel-left': 'Scroll left', 'wheel-right': 'Scroll right', 'scroll-up': 'Scroll up', 'scroll-down': 'Scroll down',
};
const FUNCTION_GROUPS = [
  ['DPI', ['dpi-up', 'dpi-down', 'dpi-cycle', 'dpi-default', 'dpi-shift']],
  ['Profiles', ['profile-next', 'profile-previous', 'profile-cycle']],
  ['Other', ['g-shift', 'battery-status', 'wheel-left', 'wheel-right', 'scroll-up', 'scroll-down']],
];
/** Consumer keys the mouse can send (src/mouse/usages.ts MEDIA). */
const MEDIA = {
  'play-pause': 'Play / pause', 'next-track': 'Next track', 'previous-track': 'Previous track', stop: 'Stop',
  mute: 'Mute', 'volume-up': 'Volume up', 'volume-down': 'Volume down',
  'brightness-up': 'Screen brighter', 'brightness-down': 'Screen dimmer',
  calculator: 'Calculator', 'file-browser': 'File browser', mail: 'Mail',
  'web-home': 'Browser home', 'web-back': 'Browser back', 'web-forward': 'Browser forward', 'web-refresh': 'Browser refresh', 'web-search': 'Web search',
};

const KEY_LABELS = {
  ctrl: 'Ctrl', shift: 'Shift', alt: isMac ? 'Option' : 'Alt', gui: isMac ? 'Cmd' : 'Super',
  rctrl: 'Right Ctrl', rshift: 'Right Shift', ralt: isMac ? 'Right Option' : 'AltGr', rgui: isMac ? 'Right Cmd' : 'Right Super',
  enter: 'Enter', escape: 'Esc', backspace: 'Backspace', tab: 'Tab', space: 'Space', minus: '-', equal: '=',
  leftbracket: '[', rightbracket: ']', backslash: '\\', semicolon: ';', quote: '\'', grave: '`', comma: ',', period: '.', slash: '/',
  capslock: 'Caps Lock', printscreen: 'Print Screen', scrolllock: 'Scroll Lock', pause: 'Pause', insert: 'Insert', home: 'Home',
  pageup: 'Page Up', delete: 'Delete', end: 'End', pagedown: 'Page Down', right: '→', left: '←', down: '↓', up: '↑',
  numlock: 'Num Lock', 'kp-divide': 'Num /', 'kp-multiply': 'Num *', 'kp-minus': 'Num -', 'kp-plus': 'Num +', 'kp-enter': 'Num Enter', menu: 'Menu',
};
const keyLabel = (k) => KEY_LABELS[k] ?? (/^kp-\d$/.test(k) ? `Num ${k.slice(3)}` : k.toUpperCase());
const comboLabel = (spec) => spec.split('+').map(keyLabel).join(' + ');

/** What a macro step looks like to a person ("ctrl+c" → "Ctrl + C"). */
function stepLabel(s) {
  let m;
  if ((m = s.match(/^(\d+)ms$/))) return `${m[1]} ms`;
  if ((m = s.match(/^mouse:(.+)$/))) return m[1].split('+').map((b) => MOUSE_BUTTONS[b] ?? `Button ${b}`).join(' + ');
  if ((m = s.match(/^media:(.+)$/))) return MEDIA[m[1]] ?? m[1];
  if ((m = s.match(/^(down|up):(.+)$/))) return `${m[1] === 'down' ? 'Hold' : 'Release'} ${m[2].startsWith('mouse:') ? stepLabel(m[2]) : comboLabel(m[2])}`;
  if ((m = s.match(/^(h?wheel):(-?\d+)$/))) {
    const n = Number(m[2]);
    return `Scroll ${m[1] === 'wheel' ? (n < 0 ? 'down' : 'up') : n < 0 ? 'left' : 'right'} ${Math.abs(n)}`;
  }
  return comboLabel(s);
}

/**
 * An assignment as the service shows it (src/mouse/service.ts) → { icon, text, sub, runs }, where
 * runs says who performs it: 'mouse' (stored on it), 'computer' (needs the agent) or null.
 */
function describe(a, control) {
  const [kind, ...rest] = a.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'default':
      return { icon: 'reset', text: 'Default', sub: control ? `What the ${CONTROLS[control]?.name.toLowerCase() ?? 'control'} does without a profile` : null, runs: 'mouse' };
    case 'disabled':
      return { icon: 'ban', text: 'Disabled', sub: 'Does nothing', runs: null };
    case 'mouse':
      return { icon: 'pointer', text: arg.split('+').map((b) => MOUSE_BUTTONS[b] ?? `Mouse button ${b}`).join(' + '), runs: 'mouse' };
    case 'key':
      return { icon: 'keyboard', text: comboLabel(arg), keys: arg.split('+').map(keyLabel), runs: 'mouse' };
    case 'media':
      return { icon: 'music', text: MEDIA[arg] ?? `Media key ${arg}`, runs: 'mouse' };
    case 'fn':
      return { icon: arg.startsWith('dpi') ? 'gauge' : arg.startsWith('profile') ? 'layers' : arg === 'g-shift' ? 'shift' : 'mouse', text: FUNCTIONS[arg] ?? `Function ${arg}`, runs: 'mouse' };
    case 'text':
      return { icon: 'type', text: 'Types text', sub: `“${arg}”`, runs: 'mouse' };
    case 'double-click':
      return { icon: 'pointer', text: 'Double click', runs: 'mouse' };
    case 'macro':
      if (arg.startsWith('missing(')) return { icon: 'alert', text: 'Missing macro', sub: 'The macro this points at is gone. Assign something else.', runs: null };
      return { icon: 'zap', text: 'Macro', sub: arg.split(/,\s*/).map(stepLabel).join(' · '), runs: 'mouse' };
    case 'open':
      return { icon: 'rocket', text: `Opens ${arg}`, runs: 'computer' };
    case 'run':
      return { icon: 'terminal', text: 'Runs a command', sub: arg, runs: 'computer' };
    case 'software-only':
      return { icon: 'alert', text: 'G Hub action', sub: 'G Hub only performs this while it runs; on the mouse it does nothing.', runs: null };
    default:
      return { icon: 'chip', text: 'Set by other software', sub: a, runs: 'mouse' };
  }
}

// ------------------------------------------------------------------ keyboard capture

const CODE_KEYS = {
  Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Space: 'space', Minus: 'minus', Equal: 'equal',
  BracketLeft: 'leftbracket', BracketRight: 'rightbracket', Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'quote',
  Backquote: 'grave', Comma: 'comma', Period: 'period', Slash: 'slash', CapsLock: 'capslock', PrintScreen: 'printscreen',
  ScrollLock: 'scrolllock', Pause: 'pause', Insert: 'insert', Home: 'home', PageUp: 'pageup', Delete: 'delete', End: 'end',
  PageDown: 'pagedown', ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', NumLock: 'numlock',
  NumpadDivide: 'kp-divide', NumpadMultiply: 'kp-multiply', NumpadSubtract: 'kp-minus', NumpadAdd: 'kp-plus', NumpadEnter: 'kp-enter', ContextMenu: 'menu',
};
const CODE_MODIFIERS = { ControlLeft: 'ctrl', ControlRight: 'rctrl', ShiftLeft: 'shift', ShiftRight: 'rshift', AltLeft: 'alt', AltRight: 'ralt', MetaLeft: 'gui', MetaRight: 'rgui' };
const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'gui', 'rctrl', 'rshift', 'ralt', 'rgui'];

/** The key name the mouse uses for a KeyboardEvent.code (layout independent, like the HID usage). */
function codeKey(code) {
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1].toLowerCase();
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^F(\d{1,2})$/))) return `f${m[1]}`;
  if ((m = code.match(/^Numpad(\d)$/))) return `kp-${m[1]}`;
  return CODE_KEYS[code];
}

/** A box that records the key combination pressed in it. onCombo("ctrl+shift+t"). */
function keyCapture({ onCombo }) {
  const keys = el('span', { class: 'keys' });
  const box = el('div', { class: 'key-capture', tabindex: '0', role: 'textbox', 'aria-label': 'Press a key or key combination' }, keys);
  const held = new Set();
  let used = false;
  const show = (combo) => {
    keys.replaceChildren(...(combo ? combo.split('+').map((k) => el('kbd', {}, keyLabel(k))) : [el('span', { class: 'placeholder' }, 'Click here, then press the keys')]));
  };
  const mods = () => MODIFIER_ORDER.filter((m) => held.has(m));
  box.addEventListener('keydown', (e) => {
    // Plain Tab and Shift+Tab still move focus; type those in the field below instead.
    if (e.code === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const mod = CODE_MODIFIERS[e.code];
    if (mod) {
      held.add(mod);
      used = false;
      show(mods().join('+'));
      return;
    }
    const key = codeKey(e.code);
    if (!key) return;
    used = true;
    const combo = [...mods(), key].join('+');
    show(combo);
    onCombo(combo);
  });
  box.addEventListener('keyup', (e) => {
    const mod = CODE_MODIFIERS[e.code];
    if (!mod) return;
    // A modifier pressed and released on its own is a binding too (e.g. Shift).
    if (!used && held.size) {
      const combo = mods().join('+');
      show(combo);
      onCombo(combo);
      used = true;
    }
    held.delete(mod);
  });
  box.addEventListener('blur', () => held.clear());
  show('');
  return { el: box, set: show };
}

/**
 * Records keys pressed in a box as macro steps (the syntax of src/mouse/macros.ts): a tap is
 * "c", a combination "ctrl+c", anything else "down:x" / "up:x", with the pauses if asked for.
 */
function macroRecorder({ onSteps }) {
  let events = [];
  let recording = false;
  const box = el('div', { class: 'key-capture recorder', tabindex: '0', role: 'textbox', 'aria-label': 'Macro recorder: press keys here' });
  const btn = el('button', { class: 'btn sm', type: 'button' });
  const pauses = el('input', { type: 'checkbox', id: 'rec-pauses' });
  const paint = () => {
    btn.replaceChildren(ic(recording ? 'stop' : 'record', 14), recording ? 'Stop' : 'Record keys');
    box.classList.toggle('on', recording);
    box.textContent = recording ? (events.length ? `${events.filter((e) => e.type === 'down').length} keys…` : 'Recording: type your keys here') : 'Press Record, then type the keys of your macro here.';
  };
  const finish = () => {
    recording = false;
    paint();
    if (events.length) onSteps(compress(events, pauses.checked));
  };
  // Keep the focus in the box: leaving it ends the recording, and the click would start another.
  btn.addEventListener('mousedown', (e) => { if (recording) e.preventDefault(); });
  btn.addEventListener('click', () => {
    if (recording) return finish();
    events = [];
    recording = true;
    paint();
    box.focus();
  });
  for (const type of ['keydown', 'keyup']) {
    box.addEventListener(type, (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const key = CODE_MODIFIERS[e.code] ?? codeKey(e.code);
      if (key) events.push({ type: type === 'keydown' ? 'down' : 'up', key, t: e.timeStamp });
      paint();
    });
  }
  box.addEventListener('blur', () => { if (recording) finish(); });
  paint();
  return {
    el: el('div', { class: 'recorder-wrap' }, box,
      el('div', { class: 'recorder-foot' }, btn, el('label', { class: 'check', for: 'rec-pauses' }, pauses, 'Keep the pauses between keys'))),
  };
}

function compress(events, keepPauses) {
  const out = [];
  const isMod = (k) => MODIFIER_ORDER.includes(k);
  const held = []; // modifiers down, in order: { key, emitted, used }
  let lastT = events[0]?.t ?? 0;
  const emit = (token, t) => {
    const gap = Math.round((t - lastT) / 10) * 10;
    if (keepPauses && out.length && gap >= 10) out.push(`${Math.min(gap, 65000)}ms`);
    out.push(token);
    lastT = t;
  };
  const emitHeld = (t) => {
    for (const h of held) if (!h.emitted) { emit(`down:${h.key}`, t); h.emitted = true; }
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (isMod(e.key)) {
      if (e.type === 'down') held.push({ key: e.key, emitted: false, used: false });
      else {
        const k = held.findIndex((h) => h.key === e.key);
        if (k < 0) continue;
        const [h] = held.splice(k, 1);
        if (h.emitted) emit(`up:${h.key}`, e.t);
        else if (!h.used) emit(h.key, e.t);
      }
      continue;
    }
    const next = events[i + 1];
    if (e.type === 'down' && next?.type === 'up' && next.key === e.key) {
      // A tap, with the held modifiers that weren't sent on their own: a combination.
      const mods = held.filter((h) => !h.emitted);
      mods.forEach((h) => (h.used = true));
      emit([...mods.map((h) => h.key), e.key].join('+'), e.t);
      i++;
    } else {
      emitHeld(e.t);
      emit(`${e.type}:${e.key}`, e.t);
    }
  }
  for (const h of held) if (h.emitted) emit(`up:${h.key}`, lastT);
  return out.join(', ');
}

// ------------------------------------------------------------------ the assignment dialog

const CATEGORIES = [
  { id: 'mouse', label: 'Mouse buttons', icon: 'pointer' },
  { id: 'key', label: 'Keyboard', icon: 'keyboard' },
  { id: 'media', label: 'Media keys', icon: 'music' },
  { id: 'fn', label: 'DPI and profiles', icon: 'gauge' },
  { id: 'macro', label: 'Macro', icon: 'zap' },
  { id: 'text', label: 'Text', icon: 'type' },
  { id: 'launch', label: 'Launch', icon: 'rocket' },
  { id: 'other', label: 'Default or off', icon: 'ban' },
];
const categoryOf = (a) => {
  const kind = a.split(':')[0];
  if (kind === 'double-click') return 'macro';
  if (kind === 'open' || kind === 'run') return 'launch';
  return CATEGORIES.some((c) => c.id === kind) ? kind : 'other';
};

/**
 * Pick what a control does. `submit(text)` applies it and resolves with an error message or null;
 * the dialog stays open on an error so it can be fixed.
 */
function assignDialog({ title, current, agentNote, submit }) {
  return new Promise((resolve) => {
    let value = current;
    const preview = el('div', { class: 'assign-preview' });
    const errorLine = el('div', { class: 'field-hint', role: 'alert' });
    const ok = el('button', { class: 'btn primary', type: 'submit' }, 'Assign');
    const setValue = (v) => {
      value = v;
      errorLine.textContent = '';
      const d = v ? describe(v) : null;
      ok.disabled = !v;
      preview.replaceChildren(...(d ? [ic(d.icon, 16), el('span', {}, el('b', {}, d.text), d.sub ? el('span', { class: 'sub' }, ` ${d.sub}`) : null),
        d.runs === 'computer' ? el('span', { class: 'pill warn' }, 'Needs Libre Hub running') : d.runs === 'mouse' ? el('span', { class: 'pill' }, 'Stored on the mouse') : null] : [el('span', { class: 'sub' }, 'Pick something on the left.')]));
    };
    const option = (v, label, iconName) =>
      el('button', { type: 'button', class: 'assign-option', role: 'radio', 'aria-checked': String(v === current), 'data-value': v,
        onclick: (e) => {
          for (const b of e.currentTarget.parentElement.querySelectorAll('.assign-option')) b.setAttribute('aria-checked', String(b === e.currentTarget));
          setValue(v);
        } }, iconName ? ic(iconName, 16) : null, label);
    const list = (items) => el('div', { class: 'assign-options', role: 'radiogroup' }, items);
    const field = (attrs) => el('input', { class: 'field', type: 'text', spellcheck: 'false', ...attrs });
    const help = (...t) => el('p', { class: 'assign-help' }, ...t);

    const panels = {
      mouse: () => list(Object.entries(MOUSE_BUTTONS).map(([k, label]) => option(`mouse:${k}`, label))),
      key: () => {
        const typed = field({ placeholder: 'or type it: ctrl+shift+t', value: current.startsWith('key:') ? current.slice(4) : '', 'aria-label': 'Key combination' });
        const capture = keyCapture({ onCombo: (c) => { typed.value = c; setValue(`key:${c}`); } });
        if (current.startsWith('key:')) capture.set(current.slice(4));
        typed.addEventListener('input', () => { capture.set(''); setValue(typed.value.trim() ? `key:${typed.value.trim().toLowerCase().replace(/\s+/g, '')}` : ''); });
        return el('div', { class: 'assign-stack' }, capture.el, typed,
          help('The mouse sends the key itself, so it works in every app and with nothing running. Keys are sent by position, as on a US keyboard.'));
      },
      media: () => list(Object.entries(MEDIA).map(([k, label]) => option(`media:${k}`, label))),
      fn: () => el('div', { class: 'assign-stack' }, ...FUNCTION_GROUPS.map(([group, ids]) =>
        el('div', {}, el('div', { class: 'section-label' }, group), list(ids.map((id) => option(`fn:${id}`, FUNCTIONS[id])))))),
      macro: () => {
        const area = el('textarea', { class: 'field area', rows: '3', spellcheck: 'false', placeholder: 'ctrl+c, 50ms, ctrl+v',
          'aria-label': 'Macro steps' }, current.startsWith('macro:') ? current.slice(6) : '');
        area.addEventListener('input', () => setValue(area.value.trim() ? `macro:${area.value.trim()}` : ''));
        const recorder = macroRecorder({ onSteps: (steps) => { area.value = steps; setValue(`macro:${steps}`); } });
        return el('div', { class: 'assign-stack' },
          list([option('double-click', 'Double click', 'pointer')]),
          el('div', { class: 'section-label' }, 'Your own macro'),
          recorder.el, area,
          help('Steps, separated by commas: a key or combination (', el('code', {}, 'ctrl+c'), '), a pause (', el('code', {}, '50ms'), '), ',
            el('code', {}, 'mouse:left'), ', ', el('code', {}, 'media:mute'), ', ', el('code', {}, 'down:shift'), ' and ', el('code', {}, 'up:shift'), ', ', el('code', {}, 'wheel:-3'),
            '. The mouse plays it by itself, with nothing running.'));
      },
      text: () => {
        const input = field({ placeholder: 'Hello, World!', maxlength: '40', value: current.startsWith('text:') ? current.slice(5) : '', 'aria-label': 'Text to type' });
        const count = el('span', { class: 'count' });
        const check = () => {
          const t = input.value;
          count.textContent = `${t.length}/40`;
          if (t && !/^[\x20-\x7e]*$/.test(t)) {
            setValue('');
            errorLine.textContent = 'Only letters, digits, spaces and the symbols on a US keyboard: the mouse types by pressing keys.';
          } else setValue(t ? `text:${t}` : '');
        };
        input.addEventListener('input', check);
        queueMicrotask(() => { if (input.value) count.textContent = `${input.value.length}/40`; });
        return el('div', { class: 'assign-stack' }, el('div', { class: 'with-count' }, input, count),
          help('The mouse types this by itself, as if on a US keyboard. No emoji or accented letters.'));
      },
      launch: () => {
        const isOpen = current.startsWith('open:');
        const isRun = current.startsWith('run:');
        const mode = segmented({ label: 'What to launch', full: true,
          options: [{ value: 'open', label: 'Open an app, file or website' }, { value: 'run', label: 'Run a command' }],
          onChange: (v) => { kind = v; paint(); } });
        let kind = isRun ? 'run' : 'open';
        const input = field({ value: isOpen ? current.slice(5) : isRun ? current.slice(4) : '', 'aria-label': 'What to open or run' });
        const examples = el('div', { class: 'presets compact' });
        const paint = () => {
          input.placeholder = kind === 'open' ? 'https://example.com' : 'firefox';
          examples.replaceChildren(...(kind === 'run' && window.a50x?.platform === 'linux'
            ? [el('button', { type: 'button', class: 'chip', onclick: () => { input.value = 'loginctl lock-session'; sync(); } }, 'Lock the screen')]
            : []));
          sync();
        };
        const sync = () => setValue(input.value.trim() ? `${kind}:${input.value.trim()}` : '');
        input.addEventListener('input', sync);
        mode.set(kind);
        queueMicrotask(paint);
        return el('div', { class: 'assign-stack' }, mode.el, input, examples, help(agentNote));
      },
      other: () => list([option('default', 'Default', 'reset'), option('disabled', 'Disable', 'ban')]),
    };

    const body = el('div', { class: 'assign-body' });
    const tabs = CATEGORIES.map((c) => el('button', { type: 'button', role: 'tab', class: 'assign-tab', 'data-id': c.id, 'aria-selected': 'false',
      onclick: () => pick(c.id) }, ic(c.icon, 16), c.label));
    function pick(id) {
      for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.id === id));
      body.replaceChildren(panels[id]());
      // Keep the current assignment shown until something else is picked.
      if (categoryOf(value) !== id) setValue(categoryOf(current) === id ? current : '');
    }
    const dlg = el('dialog', { class: 'assign-dialog', 'aria-labelledby': 'assign-t' },
      el('form', { method: 'dialog' },
        el('h2', { id: 'assign-t' }, title),
        el('div', { class: 'assign-grid' }, el('div', { class: 'assign-tabs', role: 'tablist', 'aria-orientation': 'vertical' }, tabs), body),
        preview, errorLine,
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'), ok)));
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!value) return;
      ok.disabled = true;
      ok.replaceChildren(el('span', { class: 'spinner sm' }), 'Saving…');
      const err = await submit(value);
      ok.replaceChildren('Assign');
      ok.disabled = false;
      if (err) errorLine.textContent = err;
      else dlg.close('ok');
    });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    pick(categoryOf(current));
    setValue(current);
    dlg.showModal();
    tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.focus();
  });
}

// ------------------------------------------------------------------ lighting

/** Effects as the service writes them ("wave:5000:horizontal:100") ↔ { type, ...params }. */
function parseEffect(t) {
  const [name, ...a] = t.split(':');
  const n = (v) => (v === undefined ? undefined : Number(v));
  switch (name) {
    case 'off': return { type: 'off' };
    case 'fixed': return { type: 'fixed', color: a[0] };
    case 'cycle': return { type: 'cycle', period: n(a[0]), brightness: n(a[1]) };
    case 'breathing': return { type: 'breathing', color: a[0], period: n(a[1]), brightness: n(a[2]) };
    case 'wave': return { type: 'wave', period: n(a[0]), direction: a[1], brightness: n(a[2]) };
    case 'pulsar-point': return { type: 'pulsar-point', frame: n(a[0]), brightness: n(a[1]) };
    case 'neutron-null': return { type: 'neutron-null', frame: n(a[0]), brightness: n(a[1]) };
    default: return { type: 'raw', text: t };
  }
}

function effectText(e, limits) {
  const clamp = (v, { min, max }, fallback) => Math.min(max, Math.max(min, Math.round(Number.isFinite(v) && v > 0 ? v : fallback)));
  const period = clamp(e.period, limits.periodMs, 5000);
  const bright = clamp(e.brightness, limits.brightness, 100);
  const frame = clamp(e.frame, limits.frameMs, limits.frameMs.min);
  switch (e.type) {
    case 'fixed': return `fixed:${e.color}`;
    case 'cycle': return `cycle:${period}:${bright}`;
    case 'breathing': return `breathing:${e.color}:${period}:${bright}`;
    case 'wave': return `wave:${period}:${e.direction === 'reverse-horizontal' ? 'reverse-horizontal' : 'horizontal'}:${bright}`;
    case 'pulsar-point':
    case 'neutron-null': return `${e.type}:${frame}:${bright}`;
    default: return 'off';
  }
}

const EFFECTS = {
  off: { label: 'Off', desc: 'No light' },
  fixed: { label: 'Fixed', desc: 'One steady colour' },
  breathing: { label: 'Breathing', desc: 'One colour, fading in and out' },
  cycle: { label: 'Colour cycle', desc: 'Every colour in turn' },
  wave: { label: 'Colour wave', desc: 'A rainbow moving across' },
  'pulsar-point': { label: 'Pulsar Point', desc: 'Logitech’s built-in animation' },
};
const SWATCHES = ['#00ffff', '#45e0b4', '#00ff00', '#ffff00', '#ff8000', '#ff0000', '#ff00ff', '#8000ff', '#0000ff', '#ffffff'];

/**
 * A row of eight LEDs that plays an effect (or shows Freestyle colours). Only an approximation of
 * the mouse; it runs only while its page shows.
 */
function ledStrip({ count = 8, interactive = false, onPick } = {}) {
  const leds = Array.from({ length: count }, (_, i) =>
    el(interactive ? 'button' : 'span', { class: 'led-dot', type: interactive ? 'button' : undefined, style: { '--i': i },
      'aria-label': interactive ? `LED ${i + 1} of ${count}, left to right` : undefined, onclick: interactive ? () => onPick?.(i) : undefined }));
  const root = el('div', { class: 'led-strip', 'aria-hidden': interactive ? undefined : 'true' }, leds);
  return {
    el: root,
    leds,
    play(e) {
      root.dataset.effect = e.type;
      root.style.setProperty('--period', `${e.period ?? 5000}ms`);
      root.style.setProperty('--frame', `${(e.frame || 32) * 40}ms`);
      root.style.setProperty('--bright', String(Math.max(0.15, (e.brightness || 100) / 100)));
      root.style.setProperty('--c', e.color ?? '#ff0000');
      root.classList.toggle('reverse', e.direction === 'reverse-horizontal');
    },
    colors(list) {
      root.dataset.effect = 'freestyle';
      leds.forEach((l, i) => l.style.setProperty('--c', list[i] ?? '#000000'));
    },
  };
}

/** Freestyle LEDs left to right, as numbered on the mouse (src/mouse/software.ts FREESTYLE_LEDS). */
const FREESTYLE_LEDS = [3, 4, 8, 7, 6, 5, 2, 1];
const FREESTYLE_WHERE = ['Strip, left end', 'Strip', 'Strip', 'Strip, middle', 'Strip', 'Strip, before the fork', 'Right side, upper', 'Right side, lower'];

/** How the idle lighting relates to the active one: dimmed, its own effect, or off. */
function idleMode(active, inactive) {
  if (inactive.type === 'off') return { mode: 'off' };
  if (inactive.type === 'neutron-null') return { mode: 'neutron-null' };
  if (inactive.type === active.type) {
    if (active.type === 'fixed') {
      const ch = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      const [a, b] = [ch(active.color), ch(inactive.color)];
      const top = Math.max(...a);
      if (top > 0) return { mode: 'dim', percent: Math.max(1, Math.min(100, Math.round((Math.max(...b) / top) * 100))) };
    } else if (active.brightness) {
      return { mode: 'dim', percent: Math.max(1, Math.min(100, Math.round((inactive.brightness / active.brightness) * 100))) };
    }
  }
  if (inactive.type === 'breathing') return { mode: 'breathing', color: inactive.color };
  return { mode: 'other', effect: inactive };
}

// ------------------------------------------------------------------ the controller

/**
 * The mouse's part of the window. `changed(what)` asks the shell to redraw: 'card' (the device
 * list), 'nav' (page buttons and hints) or 'main' (the page area).
 */
export function createMouse({ changed }) {
  let res = null; // last answer from main: { connected, offline?, asleep?, agent?, snapshot? }
  let snap = null;
  let built = null;
  let page = 'overview';
  let editing = null; // the profile the pages edit; follows the active one until you pick another
  let following = true;
  let active = false; // this device is the one shown

  const writer = createWriter((r) => {
    if (r.error && r.connected !== false) toast(friendly(r.error), { kind: 'error', timeout: 7000 });
    if (r.snapshot || r.connected === false || r.asleep) receive(r);
  }, (action) => window.g502x.apply(action));
  const send = (key, action, opts) => writer.send(key, action, opts);
  const quiet = (key) => writer.quiet(key);

  function friendly(msg) {
    if (/asleep|unknown device/i.test(msg)) return 'The mouse is asleep. Move it to wake it up, then try again.';
    if (/no response/i.test(msg)) return 'The mouse didn’t answer. Is it on and near the receiver?';
    return `Couldn’t apply that: ${msg}`;
  }

  function receive(r) {
    // Answers to a write don't always say who runs the agent; keep what we knew.
    res = r.agent || !r.connected ? r : { ...r, agent: res?.agent };
    if (r.connected && r.snapshot) {
      snap = r.snapshot;
      if (!built || built.serial !== snap.device.serial) {
        built = build(snap.device.serial);
        editing = null;
        following = true;
      }
      if (following || !snap.profiles[editing - 1]) editing = snap.activeProfile || editing || 1;
      for (const p of Object.values(built.pages)) p.update(snap);
      changed('card');
      changed('nav');
      changed('main');
      return;
    }
    if (!r.connected) {
      snap = null;
      writer.reset();
    }
    changed('card');
    changed('nav');
    changed('main');
  }

  let inflight = false;
  let again = false;
  async function refresh() {
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      receive(await window.g502x.snapshot().catch((err) => ({ connected: true, error: String(err?.message ?? err) })));
    } finally {
      inflight = false;
      if (again) { again = false; void refresh(); }
    }
  }

  // The mouse's own buttons switch profile and DPI level: follow them while this device shows.
  async function poll() {
    if (!active || !res?.connected || document.hidden || !document.hasFocus() || !writer.idle || inflight) return;
    const r = await window.g502x.live().catch(() => null);
    if (!r?.connected) return void refresh();
    const wasAsleep = !!res.asleep;
    if (r.asleep && wasAsleep) return; // still asleep; the fast check is enough
    if (!!r.asleep !== wasAsleep) {
      res = { ...res, asleep: !!r.asleep };
      if (!r.asleep) return void refresh();
      changed('card');
      changed('main');
      return;
    }
    const l = r.live;
    if (!l || !snap) return void refresh();
    if (l.mode !== snap.mode || l.activeProfile !== snap.activeProfile) return void refresh();
    if (l.dpi.current === snap.dpi.current && l.dpi.level === snap.dpi.level && l.battery.percent === snap.battery.percent && l.battery.charging === snap.battery.charging) return;
    snap = { ...snap, dpi: l.dpi, battery: l.battery };
    for (const p of Object.values(built.pages)) p.update(snap);
    changed('card');
    changed('nav');
  }
  setInterval(poll, 2000);
  // The LED previews only animate while the window is in front.
  const idle = () => document.body.classList.toggle('idle', document.hidden || !document.hasFocus());
  for (const ev of ['focus', 'blur']) window.addEventListener(ev, idle);
  document.addEventListener('visibilitychange', idle);

  let pending;
  window.g502x.onChanged((what) => {
    if (what === 'action') return; // the agent performed a software action; nothing to show
    clearTimeout(pending);
    pending = setTimeout(refresh, what === 'connection' ? 900 : 150);
  });
  // While offline, re-check now and then so the guidance follows what the user fixes.
  setInterval(() => { if (!snap) void refresh(); }, 3000);
  // Fresh battery reading now and then, also when the window is in the background.
  setInterval(() => { if (snap && !res?.asleep && writer.idle && (!active || document.hidden || !document.hasFocus())) void refresh(); }, 60000);

  const setEditing = (slot) => {
    editing = slot;
    following = slot === snap?.activeProfile;
    if (snap) for (const p of Object.values(built.pages)) p.update(snap);
  };
  const ctx = {
    send, quiet, receive: (r) => receive(r), go: (id) => show(id, { focus: true }), editing: () => editing, setEditing,
    get snap() { return snap; }, get agent() { return res?.agent; },
  };

  // -------------------------------------------------------------- pages

  function build(serial) {
    return {
      serial,
      pages: {
        overview: overviewPage(ctx),
        sensitivity: sensitivityPage(ctx),
        buttons: buttonsPage(ctx),
        lighting: lightingPage(ctx),
        settings: settingsPage(ctx),
      },
    };
  }

  function show(id, { focus = false } = {}) {
    page = id;
    changed('nav');
    changed('main');
    if (focus) built?.pages[id]?.el.querySelector('h1')?.focus({ preventScroll: true });
  }

  function offlineNode() {
    const off = res?.offline ?? (res?.connected && res.error ? { reason: 'error', error: `Couldn’t read the mouse: ${res.error}` } : { reason: res ? 'not-found' : 'connecting' });
    const reason = res?.connected && res.asleep ? 'asleep' : off.reason;
    const box = (title, body, ...extra) =>
      el('div', { class: 'empty' }, el('div', { class: 'empty-box' },
        el('div', { html: mouseArt('empty', { lit: false }) }),
        el('h1', {}, title), el('p', {}, body), ...extra));
    const waiting = (t) => el('div', { class: 'status' }, el('span', { class: 'spinner' }), t);
    switch (reason) {
      case 'connecting':
        return el('div', { class: 'empty' }, el('div', { class: 'empty-box' }, waiting('Connecting…')));
      case 'permission':
        if (window.a50x.platform === 'linux') return accessScreen();
        return box('Allow access to the receiver', off.error ?? 'Your user can’t open the receiver.', waiting('Waiting for access'));
      case 'asleep':
        return box('The mouse is asleep', 'Move it or click a button to wake it up. It sleeps after a few minutes without use.', waiting('Waiting for the mouse'));
      case 'error':
        return box('Couldn’t connect', off.error ?? 'Something went wrong talking to the receiver.', waiting('Trying again'));
      default:
        return box('Connect your G502 X PLUS', 'Plug its Lightspeed receiver into this computer, or connect the mouse with its USB cable.', waiting('Looking for the receiver'));
    }
  }

  let offline = null;
  let offlineKey = '';
  function node() {
    if (snap && built) return built.pages[page].el;
    const key = `${res?.offline?.reason}|${res?.asleep}|${res?.offline?.error ?? res?.error ?? ''}|${!!res}`;
    if (key !== offlineKey || !offline) {
      offlineKey = key;
      offline = offlineNode();
    }
    return offline;
  }

  void refresh();

  return {
    pages: MOUSE_PAGES,
    get page() { return page; },
    get online() { return !!snap; },
    get asleep() { return !!(snap && res?.asleep); },
    /** What the sidebar shows for this device. */
    card() {
      const b = snap?.battery;
      const status = snap ? (res?.asleep ? 'Asleep' : 'Connected')
        : !res ? 'Connecting…'
          : { 'not-found': 'Searching…', permission: 'No access', asleep: 'Asleep', error: 'Not connected' }[res.asleep ? 'asleep' : res.offline?.reason ?? (res.error ? 'error' : '')] ?? 'Not connected';
      return {
        name: snap?.device.name ?? 'G502 X PLUS',
        status,
        dot: snap && !res?.asleep ? 'on' : 'wait',
        battery: b ? `${b.percent}%` : null,
        batteryTitle: b ? `Battery${b.charging === 'charging' ? ', charging' : ''}` : '',
        art: mouseArt('thumb', { glow: false, lit: !!snap && !res?.asleep, small: true }),
      };
    },
    hints() {
      if (!snap) return {};
      const p = snap.profiles[snap.activeProfile - 1];
      return {
        sensitivity: [`${snap.dpi.current}`, 'DPI right now'],
        lighting: p ? [parseEffect(p.lighting.active).type === 'off' ? 'Off' : EFFECTS[parseEffect(p.lighting.active).type]?.label ?? 'Custom', 'Lighting of the active profile'] : ['', ''],
        buttons: p ? [profileName(p), 'Active profile'] : ['', ''],
      };
    },
    firmware() {
      const app = snap?.device.firmware.find((f) => f.type === 'application');
      return app ? `Firmware ${app.version}` : null;
    },
    node,
    show,
    /** Called when the user switches to (or away from) this device. */
    setActive(on) {
      active = on;
      if (on) void refresh();
    },
    refresh,
  };
}

// ------------------------------------------------------------------ shared page parts

const pageShell = (title, desc, ...body) =>
  el('section', { class: 'page' },
    el('header', { class: 'page-head' }, el('div', {}, el('h1', { tabindex: '-1' }, title), desc ? el('p', {}, desc) : null)),
    body);

const cardHead = (iconName, title, sub, right) =>
  el('div', { class: 'card-head' },
    el('div', {}, el('div', { class: 'card-title' }, ic(iconName, 18), title), sub ? el('div', { class: 'card-sub' }, sub) : null),
    right ?? null);

/**
 * The profile a page edits: one tab per onboard slot, the active one marked, and a way to make the
 * edited profile the active one.
 */
function profileBar(ctx) {
  const tabs = el('div', { class: 'profile-tabs', role: 'tablist', 'aria-label': 'Profile to edit' });
  const side = el('div', { class: 'profile-side' });
  const root = el('div', { class: 'profile-bar' }, tabs, side);
  let sig = '';
  const paint = () => {
    const s = ctx.snap;
    if (!s) return;
    const editing = ctx.editing();
    const next = JSON.stringify([s.profiles.map((p) => [profileName(p), p.enabled]), s.activeProfile, editing, s.mode]);
    if (next === sig) return;
    sig = next;
    tabs.replaceChildren(...s.profiles.map((p) =>
      el('button', { type: 'button', role: 'tab', class: `profile-tab${p.enabled ? '' : ' disabled'}`, 'aria-selected': String(p.slot === editing),
        title: `${profileName(p)}${p.enabled ? '' : ' (disabled)'}${p.slot === s.activeProfile && s.mode === 'onboard' ? ' (active)' : ''}`,
        onclick: () => ctx.setEditing(p.slot) },
        el('span', { class: 'n' }, String(p.slot)),
        el('span', { class: 't' }, profileName(p)),
        p.slot === s.activeProfile && s.mode === 'onboard' ? el('i', { class: 'dot on', 'aria-label': 'active' }) : null)));
    const p = s.profiles[editing - 1];
    const isActive = s.mode === 'onboard' && editing === s.activeProfile;
    side.replaceChildren(
      isActive ? el('span', { class: 'pill on' }, 'In use on the mouse')
        : !p?.enabled ? el('span', { class: 'pill' }, 'Disabled')
          : s.mode !== 'onboard' ? el('span', { class: 'pill warn', title: 'The mouse ignores its profiles in software mode' }, 'Software mode')
            : el('button', { class: 'btn sm', type: 'button', onclick: () => ctx.send('active', { type: 'activeProfile', profile: editing }) }, 'Use this profile'));
  };
  return { el: root, update: paint };
}

/** Explains host ("software") mode and switches the mouse back to its profiles. */
function modeNudge(ctx) {
  const node = el('div', { class: 'nudge', hidden: true, role: 'region', 'aria-label': 'Mouse mode' },
    ic('info', 16),
    el('span', {}, 'The mouse is in software mode (G Hub leaves it like this), so it ignores its saved profiles. Changes here are saved but don’t show until it runs from them.'),
    el('button', { class: 'btn sm primary', type: 'button', onclick: () => ctx.send('mode', { type: 'mode', mode: 'onboard' }) }, 'Use the saved profiles'));
  return { el: node, update: (s) => { node.hidden = s.mode === 'onboard'; } };
}

const editingProfile = (ctx, s) => s.profiles[ctx.editing() - 1] ?? s.profiles[0];

// ---------------------------------------------------------------- overview

function overviewPage(ctx) {
  const name = el('h1', { tabindex: '-1' });
  const model = el('div', { class: 'model' });
  const batteryVal = el('span', { class: 'num' });
  const batteryBar = el('i');
  const battery = el('span', { class: 'battery' }, el('span', { class: 'battery-bar' }, batteryBar), batteryVal);
  const profileStat = el('div', { class: 'value' });
  const dpiStat = el('div', { class: 'value' });
  const rateStat = el('div', { class: 'value' });
  const stat = (iconName, label, value, target) =>
    el(target ? 'button' : 'div', { class: `stat${target ? ' link' : ''}`, type: target ? 'button' : undefined, onclick: target ? () => ctx.go(target) : undefined },
      el('div', { class: 'label' }, ic(iconName, 14), label, target ? ic('chevron', 13) : null), value);
  const hero = el('div', { class: 'card hero' },
    el('div', { html: mouseArt('hero') }),
    el('div', { style: { minWidth: 0 } },
      name, model,
      el('div', { class: 'stats' },
        stat('battery', 'Battery', el('div', { class: 'value' }, battery)),
        stat('layers', 'Profile', profileStat, 'settings'),
        stat('gauge', 'DPI', dpiStat, 'sensitivity'),
        stat('signal', 'Report rate', rateStat, 'sensitivity'))));

  // Active profile
  let profiles = null;
  let profSig = '';
  const profHost = el('div');
  const profileCard = el('div', { class: 'card quick-card' },
    cardHead('layers', 'Profile', 'Saved on the mouse; the button behind the wheel switches too'),
    el('div', { class: 'quick-control' }, profHost));

  // DPI level of the active profile
  const levels = el('div', { class: 'dpi-levels', role: 'radiogroup', 'aria-label': 'DPI level' });
  let lastLevels = '';
  const shiftNote = el('span', { class: 'quiet-text' });
  const dpiCard = el('div', { class: 'card quick-card' },
    cardHead('gauge', 'DPI level', 'The DPI buttons next to the left button switch too',
      el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go('sensitivity') }, 'Edit', ic('chevron', 14))),
    el('div', { class: 'quick-control' }, levels, el('div', { class: 'quick-foot' }, shiftNote)));

  // Lighting at a glance
  const strip = ledStrip();
  const lightText = el('div', { class: 'light-text' });
  const lightCard = el('div', { class: 'card light-row' },
    el('div', { class: 'card-title' }, ic('bulb', 18), 'Lighting'),
    strip.el, lightText,
    el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go('lighting') }, 'Edit', ic('chevron', 14)));

  const agentRow = el('div', { class: 'card gate-row agent-row' });
  const nudge = modeNudge(ctx);

  const node = el('section', { class: 'page' },
    el('div', { class: 'stack' }, nudge.el, hero, el('div', { class: 'grid-2' }, profileCard, dpiCard), lightCard, agentRow));

  return {
    el: node,
    update(s) {
      nudge.update(s);
      name.textContent = s.device.name;
      model.replaceChildren(el('span', { class: `dot${s.mode === 'onboard' ? ' on' : ''}` }), el('span', {}, s.mode === 'onboard' ? 'Running from its saved profiles' : 'Software mode: not running from a profile'));
      const b = s.battery;
      batteryVal.textContent = `${b.percent}%${b.charging === 'charging' ? ' ⚡' : ''}`;
      batteryVal.title = b.charging === 'charging' ? 'Charging' : '';
      batteryBar.style.setProperty('--level', `${b.percent}%`);
      battery.classList.toggle('low', b.percent <= 20 && b.percent > 10);
      battery.classList.toggle('critical', b.percent <= 10);
      const p = s.profiles[s.activeProfile - 1];
      profileStat.textContent = s.mode !== 'onboard' ? 'Software mode' : p ? profileName(p) : '—';
      dpiStat.textContent = String(s.dpi.current);
      rateStat.textContent = `${s.reportRateHz} Hz`;

      const enabled = s.profiles.filter((x) => x.enabled);
      const sig = JSON.stringify(enabled.map((x) => [x.slot, profileName(x)]));
      if (sig !== profSig) {
        profSig = sig;
        profiles = segmented({ label: 'Active profile', full: true, options: enabled.map((x) => ({ value: x.slot, label: String(x.slot) })),
          onChange: (v) => ctx.send('active', { type: 'activeProfile', profile: Number(v) }) });
        profiles.el.querySelectorAll('button').forEach((btn, i) => (btn.title = profileName(enabled[i])));
        profHost.replaceChildren(profiles.el, el('div', { class: 'quick-foot' }, el('span', { class: 'quiet-text prof-name' })));
      }
      if (!ctx.quiet('active')) profiles.set(s.mode === 'onboard' ? s.activeProfile : -1);
      profHost.querySelector('.prof-name').textContent = s.mode === 'onboard' && p ? profileName(p) : 'Not running from a profile';

      // Rebuilt only when they change, so a keyboard user's focus survives the updates.
      const levelSig = JSON.stringify([s.mode, p?.dpiLevels, s.dpi.level, p?.shiftDpiIndex]);
      if (levelSig !== lastLevels && !ctx.quiet('dpiLevel')) {
        lastLevels = levelSig;
        levels.replaceChildren(...(!p
          ? [el('span', { class: 'quiet-text' }, 'Not running from a profile, so its DPI levels don’t apply.')]
          : p.dpiLevels.map((d, i) =>
            el('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(i === s.dpi.level), disabled: s.mode !== 'onboard',
              onclick: (e) => {
                for (const c of levels.children) c.setAttribute('aria-checked', String(c === e.currentTarget));
                ctx.send('dpiLevel', { type: 'dpiLevel', index: i });
              } }, String(d)))));
        shiftNote.textContent = p?.dpiLevels[p.shiftDpiIndex] ? `Sniper button: ${p.dpiLevels[p.shiftDpiIndex]} DPI while held` : '';
      }

      if (!p) {
        strip.play({ type: 'off' });
        lightText.replaceChildren(el('b', {}, 'Set by software'), el('span', {}, ' · not from a profile'));
      }
      if (p) {
        const e = parseEffect(p.lighting.active);
        if (p.freestyle !== 'off' && ctx.agent === 'running') {
          strip.colors(p.freestyle.split(','));
          lightText.replaceChildren(el('b', {}, 'Freestyle'), el('span', {}, ' · a colour per LED'));
        } else {
          strip.play(e);
          lightText.replaceChildren(el('b', {}, EFFECTS[e.type]?.label ?? 'Set by other software'),
            el('span', {}, p.dimAfterSeconds === null ? ' · stays on' : ` · dims after ${minutes(p.dimAfterSeconds)}`));
        }
      }

      const agent = ctx.agent;
      agentRow.replaceChildren(
        el('div', { class: 'card-title' }, ic('rocket', 18), 'Computer actions'),
        el('div', { class: 'gate-desc' }, 'Launching apps and Freestyle lighting'),
        el('span', { class: `pill ${agent === 'off' ? 'warn' : 'on'}`, style: { justifySelf: 'end' } },
          agent === 'running' ? 'Running in Libre Hub' : agent === 'elsewhere' ? 'Running in the terminal' : 'Not running'),
        el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go('settings') }, 'Details', ic('chevron', 14)));
    },
  };
}

// ---------------------------------------------------------------- sensitivity

/** Where a DPI value sits on the track (log scale, so 400 and 800 don't overlap). */
const dpiPos = (d, { min, max }) => (Math.log(d / min) / Math.log(max / min)) * 100;

function sensitivityPage(ctx) {
  const bar = profileBar(ctx);
  const nudge = modeNudge(ctx);
  const presets = el('div', { class: 'presets', role: 'group', 'aria-label': 'DPI presets' });
  const track = el('div', { class: 'dpi-track', 'aria-hidden': 'true' });
  const rows = el('div', { class: 'dpi-rows' });
  const liveNote = el('div', { class: 'card-value text' });
  const addBtn = el('button', { class: 'btn sm', type: 'button' }, ic('plus', 15), 'Add a level');
  const rate = segmented({ label: 'Report rate', full: true, options: [125, 250, 500, 1000].map((hz) => ({ value: hz, label: `${hz} Hz` })),
    onChange: (hz) => ctx.send(`rate:${ctx.editing()}`, { type: 'reportRate', profile: ctx.editing(), hz: Number(hz) }) });

  // What the user is editing, kept while their write is under way.
  let draft = null;
  let draftSlot = 0;
  let timer = 0;
  let later = null;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    later?.();
    later = null;
  };
  const commit = (soon = false) => {
    clearTimeout(timer);
    const slot = draftSlot;
    const { levels, def, shift } = draft;
    const go = () => ctx.send(`dpi:${slot}`, { type: 'dpi', profile: slot, levels: [...levels], defaultIndex: def, shiftIndex: shift });
    // The +/- buttons wait for a pause, so five clicks are one write to the mouse.
    if (soon) {
      later = go;
      timer = setTimeout(flush, 700);
    } else {
      later = null;
      timer = 0;
      go();
    }
    paint();
  };

  const limits = () => ctx.snap.capabilities.dpi;
  const snapTo = (v) => {
    const { min, max, step } = limits();
    return Math.min(max, Math.max(min, Math.round(v / step) * step));
  };

  function paint() {
    if (!draft) return;
    const lim = limits();
    let crowdedLast = false;
    track.replaceChildren(
      el('div', { class: 'dpi-rail' }),
      ...[100, 400, 1600, 6400, 25600].filter((t) => t >= lim.min && t <= lim.max).map((t) => el('span', { class: 'dpi-tick', style: { left: `${dpiPos(t, lim)}%` } }, t >= 1000 ? `${t / 1000}k` : String(t))),
      ...draft.levels.map((d, i) => {
        // Labels of levels close together take turns sitting higher, so they don't overlap.
        const pos = dpiPos(d, lim);
        const crowded = i > 0 && pos - dpiPos(draft.levels[i - 1], lim) < 4 && !crowdedLast;
        crowdedLast = crowded;
        return el('span', { class: `dpi-mark${i === draft.def ? ' def' : ''}${i === draft.shift ? ' shift' : ''}${crowded ? ' up' : ''}`, style: { left: `${pos}%` } }, el('b', {}, String(d)));
      }));
    const name = `dpi-def-${Math.random().toString(36).slice(2, 6)}`;
    // The rows are rebuilt; put keyboard focus back on the same control (or its neighbour, after a removal).
    const focused = rows.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    rows.replaceChildren(...draft.levels.map((d, i) => {
      const input = el('input', { class: 'field num dpi-input', type: 'number', min: lim.min, max: lim.max, step: lim.step, value: d, 'aria-label': `Level ${i + 1} DPI`, 'data-focus': `in${i}` });
      // Waits for a pause too: arrow keys fire a change per step.
      input.addEventListener('change', () => {
        const v = snapTo(Number(input.value) || d);
        input.value = String(v);
        draft.levels[i] = v;
        commit(true);
      });
      const nudgeBy = (delta) => { draft.levels[i] = snapTo(draft.levels[i] + delta); input.value = String(draft.levels[i]); commit(true); };
      return el('div', { class: `dpi-row${i === draft.def ? ' def' : ''}` },
        el('span', { class: 'dpi-n' }, `Level ${i + 1}`),
        el('div', { class: 'stepper' },
          el('button', { class: 'btn ghost sm icon-only', type: 'button', 'aria-label': `Lower level ${i + 1} by ${lim.step}`, 'data-focus': `lo${i}`, onclick: () => nudgeBy(-lim.step) }, '−'),
          input,
          el('button', { class: 'btn ghost sm icon-only', type: 'button', 'aria-label': `Raise level ${i + 1} by ${lim.step}`, 'data-focus': `hi${i}`, onclick: () => nudgeBy(lim.step) }, '+')),
        el('label', { class: 'radio' }, el('input', { type: 'radio', name, checked: i === draft.def, 'data-focus': `def${i}`, onchange: () => { draft.def = i; commit(); } }), 'Starts here'),
        el('label', { class: 'radio' }, el('input', { type: 'radio', name: `${name}-s`, checked: i === draft.shift, 'data-focus': `sh${i}`, onchange: () => { draft.shift = i; commit(); } }), 'Sniper'),
        el('button', { class: 'btn ghost sm icon-only', type: 'button', 'aria-label': `Remove level ${i + 1}`, title: 'Remove this level', disabled: draft.levels.length <= 1, 'data-focus': `rm${i}`,
          onclick: () => {
            draft.levels.splice(i, 1);
            const fix = (k) => (k === i ? 0 : k > i ? k - 1 : k);
            draft.def = fix(draft.def);
            draft.shift = fix(draft.shift);
            commit();
          }, html: icon('x', 15) }));
    }));
    if (focused) {
      const [, kind, n] = focused.match(/^([a-z]+)(\d+)$/) ?? [];
      const at = Math.min(Number(n), draft.levels.length - 1);
      (rows.querySelector(`[data-focus="${kind}${at}"]`) ?? addBtn).focus();
    }
    addBtn.disabled = draft.levels.length >= 5;
    const matching = ctx.snap.capabilities.dpiPresets.find((p) => p.levels.join() === draft.levels.join() && p.defaultIndex === draft.def && p.shiftIndex === draft.shift)?.name;
    for (const c of presets.children) c.setAttribute('aria-pressed', String(c.dataset.name === matching));
  }

  addBtn.addEventListener('click', () => {
    const last = draft.levels.at(-1) ?? 800;
    draft.levels.push(snapTo(Math.min(limits().max, last * 2)));
    commit();
  });

  const PRESET_LABELS = { default: 'Default', 'first-person': 'First person', 'third-person': 'Third person', mmorpg: 'MMORPG', moba: 'MOBA', rts: 'RTS', simulation: 'Simulation', productivity: 'Productivity' };
  let presetSig = '';

  const dpiCard = el('div', { class: 'card' },
    cardHead('gauge', 'DPI levels', 'Up to five. The DPI buttons next to the left button step through them; the sniper button holds its level.', liveNote),
    el('div', { class: 'section-label' }, 'Presets from G Hub'),
    presets, track, rows,
    el('div', { class: 'eq-foot' }, el('span', {}, 'Higher DPI moves the pointer further for the same hand movement.'), addBtn));
  const rateCard = el('div', { class: 'card' },
    cardHead('signal', 'Report rate', 'How often the mouse tells the computer where it is. Higher is smoother and uses a little more battery.'),
    rate.el);

  return {
    el: pageShell('Sensitivity', 'DPI and report rate, saved in the profile on the mouse.',
      el('div', { class: 'stack' }, nudge.el, bar.el, dpiCard, rateCard)),
    update(s) {
      nudge.update(s);
      bar.update();
      const p = editingProfile(ctx, s);
      const sig = JSON.stringify(s.capabilities.dpiPresets);
      if (sig !== presetSig) {
        presetSig = sig;
        presets.replaceChildren(...s.capabilities.dpiPresets.map((x) =>
          el('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', 'data-name': x.name, title: x.levels.join(' / '),
            onclick: () => {
              flush();
              draft = { levels: [...x.levels], def: x.defaultIndex, shift: x.shiftIndex };
              paint();
              ctx.send(`dpi:${ctx.editing()}`, { type: 'dpiPreset', profile: ctx.editing(), preset: x.name });
            } }, PRESET_LABELS[x.name] ?? cap(x.name))));
      }
      const live = s.mode === 'onboard' && p.slot === s.activeProfile;
      liveNote.replaceChildren(...(live ? [String(s.dpi.current), el('span', { class: 'of' }, ' DPI now')] : []));
      // Another profile picked while +/- clicks wait: write them now, then show the new one.
      if (timer && draftSlot !== p.slot) flush();
      const next = { levels: [...p.dpiLevels], def: p.defaultDpiIndex, shift: p.shiftDpiIndex };
      // Redrawn only when they differ from what shows, so a half-typed number isn't thrown away.
      if (!ctx.quiet(`dpi:${p.slot}`) && !timer && JSON.stringify([p.slot, next]) !== JSON.stringify([draftSlot, draft])) {
        draft = next;
        draftSlot = p.slot;
        paint();
      }
      if (!ctx.quiet(`rate:${p.slot}`)) rate.set(p.reportRateHz);
    },
  };
}

// ---------------------------------------------------------------- buttons

function buttonsPage(ctx) {
  const bar = profileBar(ctx);
  const nudge = modeNudge(ctx);
  let layer = 'base';
  const layerSwitch = segmented({ label: 'Layer', options: [{ value: 'base', label: 'Normal' }, { value: 'gshift', label: 'While G-Shift is held' }],
    onChange: (v) => { layer = v; paint(); } });
  layerSwitch.set('base');
  const layerNote = el('div', { class: 'note', hidden: true });
  const list = el('div', { class: 'assign-list' });
  let last = null;

  let shown = '';
  function paint() {
    const s = last;
    if (!s) return;
    const p = editingProfile(ctx, s);
    const busy = p.buttons.map((b) => ctx.quiet(`btn:${p.slot}:${layer}:${b.control}`));
    // Rebuilt only when something shown changed, so keyboard focus survives the updates.
    const sig = JSON.stringify([p.slot, layer, p.buttons, busy]);
    if (sig === shown) return;
    shown = sig;
    const hasShift = p.buttons.some((b) => b.binding === 'fn:g-shift');
    layerNote.hidden = layer !== 'gshift' || hasShift;
    layerNote.replaceChildren(ic('info', 16), el('span', {}, 'No button in this profile is set to G-Shift, so this layer is never used. Set one to “G-Shift (hold)” under DPI and profiles.'));
    list.replaceChildren(...p.buttons.map((b, k) => {
      const a = layer === 'gshift' ? b.gshift : b.binding;
      const c = CONTROLS[b.control] ?? { name: b.label };
      const d = describe(a, b.control);
      return el('button', { type: 'button', class: `assign-row${busy[k] ? ' busy' : ''}`, 'aria-label': `${c.name}: ${d.text}${d.sub ? `, ${d.sub}` : ''}. Change`,
        onclick: () => edit(p, b, c, a) },
        el('div', { class: 'assign-control' }, el('b', {}, c.name), c.where ? el('span', {}, c.where) : null),
        el('div', { class: 'assign-what' }, el('span', { class: 'assign-icon' }, ic(d.icon, 16)),
          el('div', { class: 'assign-text' },
            d.keys ? el('span', { class: 'keys' }, d.keys.map((k) => el('kbd', {}, k))) : el('b', {}, d.text),
            d.sub ? el('span', { class: 'sub', title: d.sub }, d.sub) : null)),
        d.runs === 'computer' ? el('span', { class: 'pill warn', title: 'Performed by this computer while Libre Hub or “librehub mouse agent” runs' }, 'Needs Libre Hub') : el('span'),
        busy[k] ? el('span', { class: 'spinner sm' }) : ic('pencil', 15));
    }));
  }

  async function edit(p, b, c, current) {
    const key = `btn:${p.slot}:${layer}:${b.control}`;
    const shown = layer === 'gshift' ? `${c.name}, with G-Shift` : c.name;
    const agent = ctx.agent;
    await assignDialog({
      title: shown,
      current,
      agentNote: agent === 'off'
        ? 'Performed by this computer while Libre Hub runs (it can stay in the tray). It isn’t running for this mouse right now.'
        : 'Performed by this computer while Libre Hub runs (it can stay in the tray), or “librehub mouse agent”. The mouse itself stores the button as disabled.',
      submit: async (value) => {
        const sent = ctx.send(key, { type: 'button', profile: p.slot, control: b.control, layer, assignment: value }, { coalesce: false });
        paint();
        const r = await sent;
        if (r.error) return r.error.replace(/^Error: /, '');
        if (!r.connected) return 'The mouse isn’t connected.';
        return null;
      },
    });
  }

  return {
    el: pageShell('Buttons', 'What each control does. Everything except launching apps is stored on the mouse and works with nothing running.',
      el('div', { class: 'stack' }, nudge.el, bar.el,
        el('div', { class: 'card' },
          cardHead('mouse', 'Assignments', 'Click a control to change it.', layerSwitch.el),
          layerNote, list))),
    update(s) {
      last = s;
      nudge.update(s);
      bar.update();
      paint();
    },
  };
}

// ---------------------------------------------------------------- lighting

function colorPicker({ label, onPick }) {
  const input = el('input', { type: 'color', class: 'color-input', value: SWATCHES[0], 'aria-label': `${label}: another colour`, title: 'Another colour' });
  const chips = SWATCHES.map((c) => el('button', { type: 'button', class: 'swatch', style: { '--c': c }, 'aria-label': `Colour ${c}`, title: c, onclick: () => { set(c); onPick(c); } }));
  const root = el('div', { class: 'colors' }, chips, input);
  input.addEventListener('change', () => onPick(input.value));
  const set = (c) => {
    input.value = c;
    for (const ch of chips) ch.setAttribute('aria-pressed', String(ch.title === c));
  };
  return { el: root, set };
}

function lightingPage(ctx) {
  const bar = profileBar(ctx);
  const nudge = modeNudge(ctx);
  const limits = () => ctx.snap.capabilities.lighting;
  let current = { type: 'off' };
  // Parameters per effect, so switching effects keeps what you chose for each.
  const params = { fixed: { color: '#00ffff' }, breathing: { color: '#00ffff', period: 5000, brightness: 100 }, cycle: { period: 5000, brightness: 100 },
    wave: { period: 5000, direction: 'horizontal', brightness: 100 }, 'pulsar-point': { frame: 32, brightness: 100 } };
  const key = () => `light:${ctx.editing()}`;
  const write = () => ctx.send(key(), { type: 'lighting', profile: ctx.editing(), target: 'active', effect: effectText(current, limits()) });

  const strip = ledStrip();
  const effectBtns = Object.entries(EFFECTS).map(([type, e]) =>
    el('button', { type: 'button', class: 'effect', role: 'radio', 'aria-checked': 'false', 'data-type': type,
      onclick: () => {
        current = { type, ...(params[type] ?? {}) };
        write();
        paint();
      } }, el('b', {}, e.label), el('span', {}, e.desc)));
  const effects = el('div', { class: 'effects', role: 'radiogroup', 'aria-label': 'Lighting effect' }, effectBtns);

  const color = colorPicker({ label: 'Effect colour', onPick: (c) => { current.color = c; params[current.type].color = c; write(); paint(); } });
  const speedVal = el('span', { class: 'val' });
  // Shown as speed (faster to the right), stored as a period.
  const speed = slider({ min: 1000, max: 20000, step: 500, label: 'Speed', quiet: () => ctx.quiet(key()),
    valueText: (v) => `${((21000 - v) / 1000).toFixed(1)} seconds per cycle`,
    onPreview: (v) => { speedVal.textContent = `${((21000 - v) / 1000).toFixed(1)} s`; },
    onCommit: (v) => { current.period = 21000 - v; params[current.type].period = current.period; write(); paint(); } });
  const frameVal = el('span', { class: 'val' });
  const frame = slider({ min: 32, max: 64, step: 1, label: 'Speed', quiet: () => ctx.quiet(key()),
    // 32 ms a frame is full speed, 64 ms half.
    valueText: (v) => `${Math.round((32 / (96 - v)) * 100)}% speed`, onPreview: (v) => { frameVal.textContent = `${Math.round((32 / (96 - v)) * 100)}%`; },
    onCommit: (v) => { current.frame = 96 - v; params[current.type].frame = current.frame; write(); paint(); } });
  const brightVal = el('span', { class: 'val' });
  const bright = slider({ min: 1, max: 100, label: 'Brightness', quiet: () => ctx.quiet(key()),
    valueText: (v) => `${v}%`, onPreview: (v) => { brightVal.textContent = `${v}%`; },
    onCommit: (v) => { current.brightness = v; params[current.type].brightness = v; write(); paint(); } });
  const direction = segmented({ label: 'Direction', options: [{ value: 'horizontal', label: 'Left to right' }, { value: 'reverse-horizontal', label: 'Right to left' }],
    onChange: (v) => { current.direction = v; params.wave.direction = v; write(); paint(); } });
  const row = (label, control, value) => el('div', { class: 'param' }, el('span', { class: 'param-k' }, label), control, value ?? el('span'));
  const rows = {
    color: row('Colour', color.el),
    speed: row('Speed', speed.el, speedVal),
    frame: row('Speed', frame.el, frameVal),
    bright: row('Brightness', bright.el, brightVal),
    direction: row('Direction', direction.el),
  };
  const rawNote = el('div', { class: 'note', hidden: true }, ic('info', 16), el('span', {}, 'Other software set an effect Libre Hub doesn’t know. Pick one to replace it.'));

  function paint() {
    const t = current.type;
    for (const b of effectBtns) b.setAttribute('aria-checked', String(b.dataset.type === t));
    rows.color.hidden = !(t === 'fixed' || t === 'breathing');
    rows.speed.hidden = !(t === 'breathing' || t === 'cycle' || t === 'wave');
    rows.frame.hidden = t !== 'pulsar-point';
    rows.bright.hidden = !(t === 'breathing' || t === 'cycle' || t === 'wave' || t === 'pulsar-point');
    rows.direction.hidden = t !== 'wave';
    rawNote.hidden = t !== 'raw';
    if (current.color) color.set(current.color);
    speed.set(21000 - Math.min(20000, Math.max(1000, current.period || 5000)));
    frame.set(96 - Math.min(64, Math.max(32, current.frame || 32)));
    bright.set(Math.min(100, Math.max(1, current.brightness || 100)));
    if (current.direction) direction.set(current.direction);
    strip.play(current);
  }

  // When idle
  const idleKey = () => `idle:${ctx.editing()}`;
  const timers = (label, field) => segmented({ label, full: true, options: [null, 60, 120, 300, 600, 900].map((v) => ({ value: String(v), label: v === null ? 'Never' : `${v / 60} min` })),
    onChange: (v) => ctx.send(`${field}:${ctx.editing()}`, { type: 'inactivity', profile: ctx.editing(), [field]: v === 'null' ? null : Number(v) }) });
  const dimAfter = timers('Switch to the idle lighting after', 'dimAfterSeconds');
  const offAfter = timers('Turn all lights off after', 'lightsOffAfterSeconds');
  let idle = { mode: 'dim', percent: 50 };
  let idleColor = '#00ffff';
  let idleBreath = { period: 5000, brightness: 100 }; // kept from the profile when it already breathes
  const idleWrite = () => {
    const slot = ctx.editing();
    const action = idle.mode === 'dim' ? { type: 'lighting', profile: slot, target: 'inactive', effect: 'dim', dimPercent: idle.percent ?? 50 }
      : idle.mode === 'breathing' ? { type: 'lighting', profile: slot, target: 'inactive', effect: effectText({ type: 'breathing', color: idle.color ?? idleColor, period: idleBreath.period, brightness: idleBreath.brightness }, limits()) }
        : { type: 'lighting', profile: slot, target: 'inactive', effect: idle.mode === 'neutron-null' ? 'neutron-null' : 'off' };
    ctx.send(idleKey(), action);
  };
  const idleChoice = segmented({ label: 'Idle lighting', full: true,
    options: [{ value: 'dim', label: 'Dimmed' }, { value: 'breathing', label: 'Breathing' }, { value: 'neutron-null', label: 'Neutron Null' }, { value: 'off', label: 'Off' }],
    onChange: (v) => { idle = { mode: v, percent: idle.percent ?? 50, color: idleColor }; idleWrite(); paintIdle(); } });
  const dimVal = el('span', { class: 'val' });
  const dim = slider({ min: 1, max: 100, label: 'Idle brightness', quiet: () => ctx.quiet(idleKey()),
    valueText: (v) => `${v}% of the normal brightness`, onPreview: (v) => { dimVal.textContent = `${v}%`; },
    onCommit: (v) => { idle = { mode: 'dim', percent: v }; idleWrite(); } });
  const idleColorPick = colorPicker({ label: 'Idle colour', onPick: (c) => { idleColor = c; idle = { mode: 'breathing', color: c }; idleWrite(); } });
  const dimRow = row('Brightness', dim.el, dimVal);
  const idleColorRow = row('Colour', idleColorPick.el);
  const idleBody = el('div', { class: 'idle-body' }, row('Lighting', idleChoice.el), dimRow, idleColorRow);
  const paintIdle = () => {
    dimRow.hidden = idle.mode !== 'dim';
    idleColorRow.hidden = idle.mode !== 'breathing';
    if (idle.mode !== 'other') idleChoice.set(idle.mode);
    if (idle.mode === 'dim') dim.set(idle.percent ?? 50);
    if (idle.mode === 'breathing') idleColorPick.set(idle.color ?? idleColor);
  };

  // Freestyle
  const fsKey = () => `fs:${ctx.editing()}`;
  let fs = null; // eight colours left to right, or null
  const fsStrip = ledStrip({ interactive: true, onPick: (i) => pickLed(i) });
  const fsPicker = el('input', { type: 'color', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  let picking = -1;
  const pickLed = (i) => {
    if (!fs) return;
    picking = i;
    fsPicker.value = fs[i];
    fsPicker.click();
  };
  fsPicker.addEventListener('change', () => {
    if (picking < 0 || !fs) return;
    fs[picking] = fsPicker.value;
    fsWrite();
  });
  const fsWrite = () => {
    paintFs();
    ctx.send(fsKey(), { type: 'freestyle', profile: ctx.editing(), colors: fs ? Object.fromEntries(FREESTYLE_LEDS.map((led, i) => [String(led), fs[i]])) : null });
  };
  const fsToggle = toggle({ label: 'Freestyle lighting', onChange: (on) => { fs = on ? (fs ?? ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff00ff']) : null; fsWrite(); } });
  const fsAll = colorPicker({ label: 'All LEDs', onPick: (c) => { fs = Array(8).fill(c); fsWrite(); } });
  const fsAgent = el('div', { class: 'note' });
  const fsBody = el('div', { class: 'fs-body' }, fsStrip.el,
    el('div', { class: 'fs-labels', 'aria-hidden': 'true' }, FREESTYLE_WHERE.map((w, i) => el('span', { title: w }, String(i + 1)))),
    row('All at once', fsAll.el), fsPicker);
  const paintFs = () => {
    fsToggle.set(!!fs);
    fsBody.hidden = !fs;
    if (fs) fsStrip.colors(fs);
    fsStrip.leds.forEach((l, i) => l.setAttribute('title', `${FREESTYLE_WHERE[i]}${fs ? `: ${fs[i]}` : ''}`));
  };

  const activeCard = el('div', { class: 'card' },
    cardHead('bulb', 'Effect', 'What the lights do while you use the mouse.', strip.el),
    effects, rawNote,
    el('div', { class: 'params' }, rows.color, rows.speed, rows.frame, rows.bright, rows.direction));
  const idleCard = el('div', { class: 'card' },
    cardHead('moon', 'When idle', 'After a while without use, the mouse switches to its idle lighting, and later turns the lights off. This saves battery.'),
    el('div', { class: 'params' }, row('Idle after', dimAfter.el), idleBody, row('Lights off after', offAfter.el)));
  const fsCard = el('div', { class: 'card' },
    cardHead('palette', 'Freestyle', 'A colour of your own for each LED. Click an LED to change it.', fsToggle.el),
    fsBody, fsAgent);

  return {
    el: pageShell('Lighting', 'The LIGHTSYNC lights, saved in the profile on the mouse.',
      el('div', { class: 'stack' }, nudge.el, bar.el, activeCard, idleCard, fsCard)),
    update(s) {
      nudge.update(s);
      bar.update();
      const p = editingProfile(ctx, s);
      if (!ctx.quiet(`light:${p.slot}`)) {
        current = parseEffect(p.lighting.active);
        if (params[current.type]) Object.assign(params[current.type], Object.fromEntries(Object.entries(current).filter(([k, v]) => k !== 'type' && v !== undefined && v !== 0)));
        paint();
      }
      if (!ctx.quiet(`idle:${p.slot}`)) {
        const inactive = parseEffect(p.lighting.inactive);
        idle = idleMode(parseEffect(p.lighting.active), inactive);
        if (idle.color) idleColor = idle.color;
        if (inactive.type === 'breathing') idleBreath = { period: inactive.period, brightness: inactive.brightness };
        paintIdle();
      }
      if (!ctx.quiet(`dimAfterSeconds:${p.slot}`)) dimAfter.set(String(p.dimAfterSeconds));
      if (!ctx.quiet(`lightsOffAfterSeconds:${p.slot}`)) offAfter.set(String(p.lightsOffAfterSeconds));
      idleBody.classList.toggle('dimmed', p.dimAfterSeconds === null);
      if (!ctx.quiet(`fs:${p.slot}`)) {
        fs = p.freestyle === 'off' ? null : p.freestyle.split(',');
        paintFs();
      }
      const agent = ctx.agent;
      fsAgent.replaceChildren(ic(agent === 'off' ? 'alert' : 'info', 16), el('span', {},
        agent === 'running' ? 'The mouse can’t store a colour per LED, so Libre Hub paints them while it runs (also from the tray). When it isn’t running, the effect above shows.'
          : agent === 'elsewhere' ? 'Painted by “librehub mouse agent”, which is running. When it isn’t, the effect above shows.'
            : 'Needs Libre Hub running to paint the LEDs, and it isn’t running for this mouse. Until then the effect above shows.'));
      fsAgent.classList.toggle('warn', agent === 'off' && !!fs);
    },
  };
}

// ---------------------------------------------------------------- settings

function settingsPage(ctx) {
  const setting = (title, desc, control) =>
    el('div', { class: 'setting' },
      el('div', {}, el('div', { class: 't' }, title), desc ? el('div', { class: 'd' }, desc) : null),
      el('div', { class: 'control' }, control));

  const modeHost = el('div', { class: 'control-inline' });
  const startup = toggle({ label: 'Device startup effect', onChange: (on) => ctx.send('startup', { type: 'startupEffect', enabled: on }) });
  const profiles = el('div', { class: 'profile-list' });
  let shownList = '';
  const agentText = el('p', { class: 'audio-text' });
  const agentPill = el('span', { class: 'pill' });
  const facts = el('div', { class: 'facts' });
  const swPath = window.a50x.platform === 'darwin' ? '~/Library/Application Support/logitech-manager/g502x.json' : '~/.config/logitech-manager/g502x.json';

  async function rename(p) {
    const name = await prompt({ title: 'Rename profile', body: 'The name is saved on the mouse, so G Hub shows it too.', label: 'Profile name',
      placeholder: `Profile ${p.slot}`, initial: p.name && p.name !== 'PROFILE_NAME_DEFAULT' ? p.name : '', confirm: 'Rename', maxlength: 24 });
    if (name) ctx.send(`name:${p.slot}`, { type: 'name', profile: p.slot, name }, { coalesce: false });
  }
  async function restore(p) {
    const yes = await confirmDialog({ title: `Restore ${profileName(p)}?`,
      body: 'This puts the factory settings back in this profile: DPI, buttons, macros, lighting and its name. Its launch actions and Freestyle colours on this computer are removed too.',
      confirm: 'Restore factory settings', danger: true });
    if (!yes) return;
    const r = await ctx.send(`restore:${p.slot}`, { type: 'restoreProfile', profile: p.slot }, { coalesce: false });
    if (r.connected && !r.error) toast(`${profileName(p)} has its factory settings again`);
  }

  const backupBtn = el('button', { class: 'btn', type: 'button' }, ic('download', 15), 'Back up');
  const restoreBtn = el('button', { class: 'btn', type: 'button' }, ic('upload', 15), 'Restore a backup…');
  backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    const r = await window.g502x.backup().catch((err) => ({ error: String(err?.message ?? err) }));
    backupBtn.disabled = false;
    if (r.error) toast(`Couldn’t back up the mouse: ${r.error}`, { kind: 'error', timeout: 8000 });
    else if (r.file) toast(`Saved the mouse’s memory to ${r.file.split(/[\\/]/).pop()}`);
  });
  restoreBtn.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: 'Restore a backup?', body: 'Everything on the mouse is replaced with what the backup holds: all five profiles, their macros and which are enabled.', confirm: 'Choose a backup…' });
    if (!yes) return;
    restoreBtn.disabled = true;
    const r = await window.g502x.restore().catch((err) => ({ error: String(err?.message ?? err) }));
    restoreBtn.disabled = false;
    if (r.snapshot) ctx.receive({ connected: true, snapshot: r.snapshot });
    if (r.error) toast(`Couldn’t restore the backup: ${r.error}`, { kind: 'error', timeout: 8000 });
    else if (r.restored) toast(r.restored.length ? `Restored the backup (${r.restored.length} of the mouse’s memory sectors changed)` : 'The mouse already matched the backup');
  });

  const node = pageShell('Settings', 'The mouse’s profiles and memory, and what runs on this computer.',
    el('div', { class: 'stack' },
      el('div', { class: 'card' },
        cardHead('layers', 'Profiles', 'Five profiles live on the mouse. The button behind the wheel cycles through the enabled ones.'),
        profiles),
      el('div', { class: 'card' },
        cardHead('mouse', 'Mouse', null),
        setting('On-board memory', 'The mouse runs from its saved profiles, with no software needed. G Hub switches it to software mode while G Hub runs.', modeHost),
        setting('Startup effect', 'A light animation when the mouse turns on.', startup.el)),
      el('div', { class: 'card' },
        cardHead('rocket', 'Computer actions and Freestyle', null, agentPill),
        agentText,
        el('div', { class: 'note' }, ic('save', 16), el('span', {}, 'Launch actions and Freestyle colours are saved on this computer in ', el('code', {}, swPath), '. Everything else lives on the mouse.'))),
      el('div', { class: 'card' },
        cardHead('save', 'Backup', 'A copy of everything in the mouse’s memory, as a file on this computer.'),
        el('div', { class: 'audio-foot' }, el('span', {}, 'Do this before big changes, or before letting other software at the mouse.'), el('div', { class: 'actions' }, backupBtn, restoreBtn))),
      appCard(),
      el('div', { class: 'card' }, cardHead('info', 'About this mouse', null), facts)));

  return {
    el: node,
    update(s) {
      modeHost.replaceChildren(s.mode === 'onboard'
        ? el('span', { class: 'pill on' }, 'On')
        : el('button', { class: 'btn sm primary', type: 'button', onclick: () => ctx.send('mode', { type: 'mode', mode: 'onboard' }) }, 'Turn on'));
      if (!ctx.quiet('startup')) startup.set(s.startupEffect);
      const agent = ctx.agent;
      agentPill.className = `pill ${agent === 'off' ? 'warn' : 'on'}`;
      agentPill.textContent = agent === 'running' ? 'Running' : agent === 'elsewhere' ? 'Running elsewhere' : 'Not running';
      agentText.textContent = agent === 'running'
        ? 'Libre Hub opens apps and runs commands when you press their buttons, and paints Freestyle colours. It keeps doing this from the tray while the window is closed.'
        : agent === 'elsewhere'
          ? '“librehub mouse agent” is running in a terminal or as a service and does this, so Libre Hub stands aside.'
          : 'Nothing is opening apps or painting Freestyle colours for this mouse right now. Reconnect the mouse, or restart Libre Hub.';

      const listSig = JSON.stringify([s.mode, s.activeProfile, s.profiles.map((p) => [p.name, p.enabled, p.dpiLevels[p.defaultDpiIndex], p.reportRateHz, p.lighting.active])]);
      if (listSig !== shownList) {
        shownList = listSig;
        profiles.replaceChildren(...s.profiles.map((p) => {
          const isActive = s.mode === 'onboard' && p.slot === s.activeProfile;
          const en = toggle({ label: `Profile ${p.slot} enabled`, onChange: (on) => {
            shownList = ''; // redraw from the mouse's answer, also if it refused
            ctx.send(`enable:${p.slot}`, { type: 'profileEnabled', profile: p.slot, enabled: on }, { coalesce: false });
          } });
          en.set(p.enabled);
          if (isActive) en.el.disabled = true;
          if (isActive) en.el.title = 'The active profile stays enabled';
          const e = parseEffect(p.lighting.active);
          return el('div', { class: `profile-item${isActive ? ' active' : ''}${p.enabled ? '' : ' off'}` },
            el('span', { class: 'n' }, String(p.slot)),
            el('div', { class: 'profile-main' },
              el('b', {}, profileName(p), isActive ? el('span', { class: 'pill on' }, 'Active') : null),
              el('span', { class: 'sub' }, `${p.dpiLevels[p.defaultDpiIndex] ?? '—'} DPI · ${p.reportRateHz} Hz · ${EFFECTS[e.type]?.label ?? 'Custom lighting'}`)),
            el('div', { class: 'actions' },
              !isActive && p.enabled && s.mode === 'onboard' ? el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.send('active', { type: 'activeProfile', profile: p.slot }) }, 'Use') : null,
              el('button', { class: 'btn ghost sm', type: 'button', onclick: () => rename(p) }, ic('pencil', 14), 'Rename'),
              el('button', { class: 'btn ghost sm', type: 'button', onclick: () => restore(p) }, ic('reset', 14), 'Restore'),
              en.el));
        }));
      }

      const d = s.device;
      const fw = (type) => d.firmware.find((f) => f.type === type);
      const rows = [
        ['Model', d.name],
        ['Firmware', fw('application') ? `${fw('application').name} ${fw('application').version}` : '—', 'mono'],
        ['Serial number', d.serial, 'mono'],
        ['Bootloader', fw('bootloader') ? `${fw('bootloader').name} ${fw('bootloader').version}` : '—', 'mono'],
        ['Battery', `${s.battery.percent}%${s.battery.charging === 'charging' ? ', charging' : ''}`],
        ['Scroll wheel', s.wheel.ratchet === 'ratchet' ? 'Clicky (ratchet)' : 'Free spin'],
        ['Mode', s.mode === 'onboard' ? 'On-board memory' : 'Software'],
        ['HID++', d.protocol, 'mono'],
      ];
      facts.replaceChildren(...rows.map(([k, v, cls = '']) =>
        el('div', { class: 'fact' }, el('span', { class: 'k' }, k), el('span', { class: `v ${cls}`, title: v }, v))));
    },
  };
}
