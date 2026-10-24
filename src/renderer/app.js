// The window: a device list in the sidebar, and the pages of the device picked there. This file is
// the shell and the A50 X control panel; the G502 X PLUS has its own (mouse.js). Pages are built
// once per device and then updated in place from device snapshots, so sliders keep working while
// the headset reports changes (e.g. its volume wheel).
import { headsetArt } from './art.js';
import { eqGraph, miniCurve } from './eq.js';
import { icon } from './icons.js';
import { dbText, gateWatch, ledMeter, levelBar } from './meters.js';
import { accessScreen, onAccessAllowed } from './access.js';
import { createMouse, MOUSE_PAGES } from './mouse.js';
import { appCard, initAppSettings, keepCard, updateCheckButton } from './prefs.js';
import { choiceCards, createWriter, el, muteButton, prompt, segmented, slider, toast } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const ic = (name, size) => el('span', { style: { display: 'contents' }, html: icon(name, size) });
const pct = (v, max) => `${Math.round((v / max) * 100)}%`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sameGains = (a, b) => !!a && !!b && a.length === b.length && a.every((g, i) => Math.abs(g - b[i]) < 0.03);

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'headphones', label: 'Headphones', icon: 'headphones' },
  { id: 'microphone', label: 'Microphone', icon: 'mic' },
  { id: 'mix', label: 'Stream Mix', icon: 'mixer' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** The device whose pages show: 'headset' or 'mouse'. */
let device = localStorage.getItem('device') === 'mouse' ? 'mouse' : 'headset';
let snap = null;
let lastSnap = null; // shown dimmed while reconnecting
let built = null;
let page = 'overview';
let offlineInfo = null;
let offlineKey = '';
let graceTimer = 0;

// ------------------------------------------------------------------ writes and status

const writer = createWriter((res) => {
  if (res.error && res.connected !== false) toast(friendlyError(res.error), { kind: 'error' });
  if (res.snapshot) receive({ connected: true, snapshot: res.snapshot });
  else if (res.connected === false) receive(res);
});
const ctx = {
  send: (key, action, opts) => writer.send(key, action, opts),
  quiet: (key) => writer.quiet(key),
  go: (id) => show(id, { focus: true }),
};

function friendlyError(msg) {
  if (/timeout|no response/i.test(msg)) return "The headset didn't respond. Is it on and in range?";
  return `Couldn't apply that change: ${msg}`;
}

// ------------------------------------------------------------------ game / chat audio split (Linux)

const audio = { status: null, busy: false, listeners: new Set() };
const onAudio = (fn) => { audio.listeners.add(fn); fn(audio); };
const notifyAudio = () => audio.listeners.forEach((fn) => fn(audio));

async function refreshAudio() {
  if (!window.a50x.audio) return;
  const res = await window.a50x.audio.status().catch(() => null);
  audio.status = res?.status ?? null;
  notifyAudio();
}

async function runAudio(op) {
  if (audio.busy || !window.a50x.audio) return;
  audio.busy = op;
  notifyAudio();
  const res = await window.a50x.audio[op]().catch((err) => ({ error: String(err?.message ?? err) }));
  audio.busy = false;
  audio.status = res.status ?? audio.status;
  notifyAudio();
  if (res.error) toast(`Couldn’t change the audio setup: ${res.error}`, { kind: 'error', timeout: 8000 });
  else if (op === 'setup' && audio.status?.active) {
    toast('Game and chat audio are now separate', { action: { label: 'Undo', run: () => runAudio('undo') }, timeout: 8000 });
  } else if (op === 'undo') toast('Back to a single audio output');
}

// ------------------------------------------------------------------ live levels (Linux, with the audio split)

/** Meters each page shows. The main process reads them from PipeWire; audio never reaches this window. */
const PAGE_METERS = { mix: ['streamOut', 'mic', 'game', 'voice'], microphone: ['mic'] };
const levels = { paused: localStorage.getItem('levelsPaused') === '1', error: null, listeners: new Set() };
const onLevels = (fn) => { levels.listeners.add(fn); fn(levelsState()); };

/**
 * hidden: nothing to meter here (macOS, no PipeWire, no base station audio, headset offline); split: needs the audio
 * split; error: couldn't start; paused: by the user; background: the window isn't focused; live.
 */
function levelsState() {
  const st = audio.status;
  if (!window.a50x.meters || !snap || !st?.supported || !(st.cardFound || st.active)) return 'hidden';
  if (!st.active) return 'split';
  if (levels.error) return 'error';
  if (levels.paused) return 'paused';
  if (document.hidden || !document.hasFocus()) return 'background';
  return 'live';
}

let levelsSeq = 0;
/** Run the meters of the visible page, and none when the window is hidden, unfocused or offline. */
async function syncLevels() {
  levels.error = null;
  const state = levelsState();
  const keys = state === 'live' && device === 'headset' ? PAGE_METERS[page] ?? [] : [];
  levels.listeners.forEach((fn) => fn(state));
  if (!window.a50x.meters) return;
  const seq = ++levelsSeq;
  const res = await window.a50x.meters.watch(keys).catch((err) => ({ running: [], error: String(err?.message ?? err) }));
  if (seq !== levelsSeq || !res.error) return;
  levels.error = res.error;
  levels.listeners.forEach((fn) => fn(levelsState()));
}

function pauseLevels(paused) {
  levels.paused = paused;
  localStorage.setItem('levelsPaused', paused ? '1' : '0');
  void syncLevels();
}

// Frames sent just before the meters stopped can still arrive: only draw while live.
window.a50x.meters?.onLevels((frame) => { if (levelsState() === 'live' && device === 'headset') built?.pages[page]?.levels?.(frame); });
// One meter stopped by itself: stop the rest too (the error hides them all) and offer to retry.
window.a50x.meters?.onLost(() => {
  if (levelsState() !== 'live') return;
  levelsSeq++;
  void window.a50x.meters.watch([]);
  levels.error = 'the reading stopped. PipeWire may have restarted.';
  levels.listeners.forEach((fn) => fn(levelsState()));
});
window.addEventListener('focus', () => { void refreshAudio(); void syncLevels(); });
window.addEventListener('blur', () => void syncLevels());
document.addEventListener('visibilitychange', () => void syncLevels());
onAudio(() => void syncLevels());

/**
 * The line above a page's meters: whether they're on, with a button to turn them off, or why there
 * are none. text.live describes this page's meters.
 */
function levelsBar(text) {
  const content = el('div', { class: 'levels-content' });
  // Screen readers hear state changes (turned off, needs setup...), not the meters themselves.
  const announce = el('span', { class: 'sr-only', role: 'status' });
  const node = el('div', { class: 'levels-bar', hidden: true }, content, announce);
  const badge = (cls, label) => el('span', { class: `live-badge ${cls}` }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), label);
  const button = (label, iconName, run, primary) =>
    el('button', { class: `btn sm${primary ? '' : ' ghost'}`, type: 'button', onclick: run },
      iconName === 'chevron' ? [label, ic(iconName, 14)] : [iconName ? ic(iconName, 14) : null, label]);
  let shown = '';
  onLevels((state) => {
    node.hidden = state === 'hidden';
    const key = `${state}|${levels.error ?? ''}`;
    if (key === shown) return;
    const first = !shown;
    shown = key;
    const hadFocus = content.contains(document.activeElement);
    node.dataset.state = state;
    const msg = (t) => el('span', { class: 'levels-text' }, t);
    const parts = {
      live: [badge('on', 'Levels on'), msg(text.live), button('Turn off', 'pause', () => pauseLevels(true))],
      background: [badge('', 'Paused'), msg('Levels pause while this window isn’t focused.'), button('Turn off', 'pause', () => pauseLevels(true))],
      paused: [ic('pause', 16), msg('Live levels are off on the Stream Mix and Microphone pages.'), button('Show levels', 'play', () => pauseLevels(false), true)],
      error: [ic('alert', 16), msg(`Couldn’t read the levels: ${levels.error}`), button('Try again', null, () => void syncLevels())],
      split: [ic('info', 16), msg('Live levels need game and chat audio split into separate devices.'),
        button('Set it up', 'chevron', () => { ctx.go('settings'); document.querySelector('.audio-card')?.scrollIntoView({ block: 'start' }); })],
    }[state];
    if (!parts) return;
    content.replaceChildren(...parts);
    if (!first && state !== 'background') announce.textContent = parts.find((p) => p.classList?.contains('levels-text'))?.textContent ?? '';
    // Keep keyboard focus on the bar's new button (e.g. Turn off → Show levels).
    if (hadFocus) content.querySelector('button')?.focus();
  });
  return node;
}

// ------------------------------------------------------------------ shell

const mouse = createMouse({
  changed: (what) => {
    if (what === 'card') renderDevices();
    if (device !== 'mouse') return;
    if (what === 'nav') {
      renderNav();
      renderFoot();
    }
    if (what === 'main') mountMouse();
  },
});

/** Show another device's pages. */
function selectDevice(id) {
  if (id === device) return;
  device = id;
  localStorage.setItem('device', id);
  const main = $('#main');
  main.classList.remove('reconnecting');
  main.inert = false;
  $('#reconnect')?.remove();
  mouse.setActive(id === 'mouse');
  renderDevices();
  renderNav();
  renderFoot();
  if (id === 'mouse') mountMouse();
  else mountHeadset();
  void syncLevels();
}

/** The status pill over a dimmed page (headset reconnecting, mouse asleep). */
function statusPill(text) {
  const pill = $('#reconnect') ?? document.body.appendChild(el('div', { id: 'reconnect', class: 'reconnect-pill', role: 'status' }));
  if (pill.dataset.text !== text) {
    pill.dataset.text = text;
    pill.replaceChildren(el('span', { class: 'spinner' }), text);
  }
}

function mountMouse() {
  const main = $('#main');
  const node = mouse.node();
  if (main.firstElementChild !== node) {
    main.replaceChildren(node);
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
    main.scrollTop = 0;
  }
  // Asleep: keep the pages, dimmed, until it answers again.
  main.classList.toggle('reconnecting', mouse.asleep);
  main.inert = mouse.asleep;
  if (mouse.asleep) statusPill('The mouse is asleep. Move it to wake it up.');
  else $('#reconnect')?.remove();
}

/** Put the headset's current state back in the page area (after looking at the mouse). */
function mountHeadset() {
  const main = $('#main');
  if (snap) return show(page);
  if (graceTimer && built) {
    main.replaceChildren(built.pages[page].el);
    main.classList.add('reconnecting');
    main.inert = true;
    statusPill('Reconnecting to the headset…');
    return;
  }
  if (offlineInfo) {
    offlineKey = '';
    return showOffline(offlineInfo);
  }
  main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-box' }, el('div', { class: 'status' }, el('span', { class: 'spinner' }), 'Connecting…'))));
}

let navSig = '';
function renderNav(reconnecting = false) {
  const mine = device === 'mouse';
  const pages = mine ? MOUSE_PAGES : PAGES;
  const online = mine ? mouse.online : !!snap;
  const current = mine ? mouse.page : page;
  // Rebuilt only when the buttons change, so focus and hover survive snapshots.
  const sig = `${device}|${online}`;
  if (sig !== navSig) {
    navSig = sig;
    $('#nav').replaceChildren(...pages.map((p, i) =>
      el('button', { type: 'button', 'data-page': p.id, disabled: !online, title: `${p.label} (Ctrl+${i + 1})`,
        onclick: () => (device === 'mouse' ? mouse.show(p.id, { focus: true }) : show(p.id, { focus: true })) },
        ic(p.icon, 18), el('span', {}, p.label), el('span', { class: 'hint' }))));
  }
  for (const b of document.querySelectorAll('#nav button')) b.setAttribute('aria-current', online && b.dataset.page === current ? 'page' : 'false');
  if (mine) paintHints(mouse.hints());
  else updateNavHints(reconnecting ? lastSnap : snap);
}

function paintHints(hints) {
  for (const b of document.querySelectorAll('#nav button')) {
    const [text, what] = hints[b.dataset.page] ?? ['', ''];
    const h = b.querySelector('.hint');
    if (h.textContent !== text) h.textContent = text;
    h.title = text ? `${what}: ${text}` : '';
  }
}

function updateNavHints(s = snap) {
  if (!s || device !== 'headset') return;
  const snap = s;
  const [mic, hp] = snap.equalizers;
  paintHints({
    headphones: [hp.matches ?? 'Custom', 'Headphones EQ preset'],
    microphone: [mic.matches ?? 'Custom', 'Mic EQ preset'],
    mix: [snap.routing.output.muted ? 'Muted' : pct(snap.routing.output.gain, snap.routing.maxGain), 'Stream output level'],
  });
}

const OFFLINE_STATUS = { 'not-found': 'Searching…', permission: 'No access', unresponsive: 'Headset not answering', error: 'Not connected' };

let headsetReconnecting = false;
let devicesSig = '';
function renderDeviceCard(reconnecting = false) {
  headsetReconnecting = reconnecting;
  renderDevices();
}

/** The device list: one entry per device, the one whose pages show marked. */
function renderDevices() {
  const online = !!snap;
  const shown = online ? snap : headsetReconnecting ? lastSnap : null;
  const headset = {
    name: shown?.device.name || 'A50 X',
    status: online ? 'Connected' : headsetReconnecting ? 'Reconnecting…' : OFFLINE_STATUS[offlineInfo?.reason] ?? 'Connecting…',
    dot: online ? 'on' : 'wait',
    battery: shown ? `${shown.battery}%` : null,
    batteryTitle: 'Battery',
    dimBattery: !online,
    art: headsetArt('thumb', { glow: false, lit: online, small: true }),
  };
  const host = $('#devices');
  const card = mouse.card();
  // Rebuilt only when it changes: the headset reports often (its volume wheel), and a rebuild
  // between pressing and releasing would lose the click.
  const sig = JSON.stringify([device, headset, card]);
  if (sig === devicesSig) return;
  devicesSig = sig;
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.device : null;
  host.replaceChildren(deviceEntry('headset', headset), deviceEntry('mouse', card));
  if (focused) host.querySelector(`[data-device="${focused}"]`)?.focus();
}

function deviceEntry(id, d) {
  return el('button', { type: 'button', class: 'device-card', 'data-device': id, 'aria-current': device === id ? 'true' : 'false',
    title: `${d.name}: ${d.status}`, onclick: () => selectDevice(id) },
    el('div', { class: 'thumb', html: d.art }),
    el('div', { style: { minWidth: 0 } },
      el('div', { class: 'name' }, d.name),
      el('div', { class: 'meta' },
        el('span', { class: `dot ${d.dot}` }),
        el('span', { class: 'status' }, d.status),
        d.battery ? el('span', { class: `num${d.dimBattery ? ' dim' : ''}`, style: { marginLeft: 'auto' }, title: d.batteryTitle }, d.battery) : null)));
}

const updateCheck = updateCheckButton();
function renderFoot() {
  const foot = $('#sidebar-foot');
  const firmware = device === 'mouse' ? mouse.firmware() : snap ? `Firmware ${snap.device.firmware.version}` : null;
  foot.hidden = !firmware;
  if (firmware) foot.replaceChildren(el('div', { class: 'row' }, el('span', {}, firmware), updateCheck));
}

function show(id, { focus = false } = {}) {
  page = id;
  if (!built || device !== 'headset') return;
  const main = $('#main');
  const node = built.pages[id].el;
  if (main.firstElementChild !== node) {
    built.pages[id].resetLevels?.();
    main.replaceChildren(node);
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
    main.scrollTop = 0;
  }
  for (const b of document.querySelectorAll('#nav button')) b.setAttribute('aria-current', b.dataset.page === id ? 'page' : 'false');
  // Move focus to the page heading so keyboard and screen-reader users land on the new page.
  if (focus) node.querySelector('h1')?.focus({ preventScroll: true });
  void syncLevels();
}

// ------------------------------------------------------------------ data flow

function receive(res) {
  if (res.connected && res.snapshot) {
    const wasOnline = !!snap;
    clearTimeout(graceTimer);
    graceTimer = 0;
    if (device === 'headset') {
      $('#main').classList.remove('reconnecting');
      $('#main').inert = false;
    }
    snap = res.snapshot;
    lastSnap = snap;
    offlineInfo = null;
    if (device === 'headset') $('#reconnect')?.remove();
    offlineKey = '';
    // Same headset after a dropout: keep the pages (and whatever the user had open).
    if (!built || built.serial !== snap.device.serial) built = build(snap.device.serial);
    for (const p of Object.values(built.pages)) p.update(snap);

    if (!wasOnline) {
      void refreshAudio();
      renderNav();
      show(page);
      renderFoot();
    }
    updateNavHints();
    renderDeviceCard();
    return;
  }
  const info = res.offline ?? { reason: 'not-found' };
  if (snap) {
    // Just lost it: give it a few seconds to come back before replacing the page.
    snap = null;
    writer.reset();
    offlineInfo = info;
    if (device === 'headset') {
      $('#main').classList.add('reconnecting');
      $('#main').inert = true;
      statusPill('Reconnecting to the headset…');
    }
    renderNav(true);
    renderDeviceCard(true);
    renderFoot();
    void syncLevels();
    graceTimer = setTimeout(() => { graceTimer = 0; showOffline(offlineInfo); }, 3000);
    return;
  }
  offlineInfo = info;
  if (!graceTimer) showOffline(info);
}

function showOffline(info) {
  const key = `${info.reason}|${info.error ?? ''}`;
  if (key === offlineKey) return;
  offlineKey = key;
  lastSnap = null;
  renderNav();
  renderDeviceCard();
  renderFoot();
  if (device !== 'headset') return;
  $('#main').classList.remove('reconnecting');
  $('#main').inert = false;
  $('#reconnect')?.remove();
  $('#main').replaceChildren(offlineView(info));
}

let inflight = false;
let again = false;
async function refresh() {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    receive(await window.a50x.snapshot());
  } finally {
    inflight = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}

let pending;
window.a50x.onChanged(() => {
  clearTimeout(pending);
  pending = setTimeout(refresh, 120);
});
// While offline, re-check now and then so the guidance follows what the user fixes.
setInterval(() => { if (!snap) void refresh(); }, 2500);

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('dialog[open]')) return;
  const n = Number(e.key);
  // Mute is the headset's, whichever device shows.
  if (e.key.toLowerCase() === 'm' && !e.repeat && snap) {
    e.preventDefault();
    built?.pages.overview.toggleMute();
    return;
  }
  if (device === 'mouse') {
    if (mouse.online && n >= 1 && n <= MOUSE_PAGES.length) {
      e.preventDefault();
      mouse.show(MOUSE_PAGES[n - 1].id, { focus: true });
    }
    return;
  }
  if (!snap) return;
  if (n >= 1 && n <= PAGES.length) {
    e.preventDefault();
    show(PAGES[n - 1].id, { focus: true });
  }
});

// ------------------------------------------------------------------ pages

function build(serial) {
  return {
    serial,
    pages: {
      overview: overviewPage(),
      headphones: headphonesPage(),
      microphone: microphonePage(),
      mix: mixPage(),
      settings: settingsPage(),
    },
  };
}

const pageShell = (title, desc, ...body) =>
  el('section', { class: 'page' },
    el('header', { class: 'page-head' }, el('div', {}, el('h1', { tabindex: '-1' }, title), desc ? el('p', {}, desc) : null)),
    body);

const cardHead = (iconName, title, sub, right) =>
  el('div', { class: 'card-head' },
    el('div', {}, el('div', { class: 'card-title' }, ic(iconName, 18), title), sub ? el('div', { class: 'card-sub' }, sub) : null),
    right ?? null);

/** Preset buttons for an EQ: curated, then custom, then a "Custom" chip for an unsaved curve. */
function presetChips({ label, onCurated, onCustom, onRestore, onDelete, limitCustom = Infinity }) {
  const root = el('div', { class: 'presets', role: 'group', 'aria-label': label });
  let sig = '';
  let custom = null;
  return {
    el: root,
    /** v: EqualizerView; restorable: an earlier unsaved curve the Custom chip can bring back. */
    update(v, active, restorable) {
      const shownCustom = v.custom.filter((p, i) => i < limitCustom || p.name === active);
      const s = JSON.stringify([v.curated, shownCustom.map((p) => [p.id, p.name]), !!onDelete]);
      if (s !== sig) {
        sig = s;
        custom = el('button', { class: 'chip unsaved', type: 'button', 'aria-pressed': 'false', 'data-name': '',
          title: 'Your unsaved curve', onclick: () => onRestore?.() }, 'Custom');
        root.replaceChildren(...[
          ...v.curated.map((n, i) => el('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', 'data-name': n, onclick: () => onCurated(i, n) }, n)),
          shownCustom.length ? el('span', { class: 'sep', 'aria-hidden': 'true' }) : null,
          ...shownCustom.map((p) => {
            const chip = el('button', { class: 'chip custom', type: 'button', 'aria-pressed': 'false', 'data-name': p.name, title: p.name, onclick: () => onCustom(p) },
              el('span', { class: 'chip-text' }, p.name));
            return onDelete
              ? el('span', { class: 'chip-group' }, chip,
                el('button', { class: 'chip-del', type: 'button', 'aria-label': `Delete preset ${p.name}`, title: 'Delete preset', onclick: () => onDelete(p), html: icon('x', 13) }))
              : chip;
          }),
          custom].filter(Boolean));
      }
      if (active === undefined) return; // mid-write: keep what the user just picked
      for (const c of root.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c.dataset.name === (active ?? '')));
      custom.hidden = !(active === null || restorable);
      custom.disabled = active === null;
    },
  };
}

// ---------------------------------------------------------------- overview

function overviewPage() {
  const name = el('h1', { tabindex: '-1' });
  const model = el('div', { class: 'model' });
  const batteryVal = el('span', { class: 'num' });
  const batteryBar = el('i');
  const battery = el('span', { class: 'battery' }, el('span', { class: 'battery-bar' }, batteryBar), batteryVal);
  const bt = el('div', { class: 'value' });
  const streamStat = el('div', { class: 'value' });
  const sleepStat = el('div', { class: 'value' });
  const stat = (iconName, label, value, target) =>
    el(target ? 'button' : 'div', { class: `stat${target ? ' link' : ''}`, type: target ? 'button' : undefined, onclick: target ? () => ctx.go(target) : undefined },
      el('div', { class: 'label' }, iconName ? ic(iconName, 14) : null, label, target ? ic('chevron', 13) : null), value);

  const hero = el('div', { class: 'card hero' },
    el('div', { html: headsetArt('hero') }),
    el('div', { style: { minWidth: 0 } },
      name, model,
      el('div', { class: 'stats' },
        stat('battery', 'Battery', el('div', { class: 'value' }, battery)),
        stat('bluetooth', 'Bluetooth', bt),
        stat('signal', 'Stream', streamStat, 'mix'),
        stat('moon', 'Sleep after', sleepStat, 'settings'))));

  // Volume
  const volVal = el('div', { class: 'card-value' });
  let vmax = 21;
  let muted = false;
  const vol = slider({ min: 0, max: 21, label: 'Headset volume', quiet: () => ctx.quiet('volume'),
    valueText: (v) => pct(v, vmax),
    onPreview: (v) => { if (!muted) volVal.textContent = pct(v, vmax); },
    onChange: (v) => ctx.send('volume', { type: 'volume', level: v }) });
  const muteBtn = el('button', { class: 'pill-toggle', type: 'button', 'aria-pressed': 'false', title: 'Mute the headset (Ctrl+M)', onclick: () => toggleMute() });
  function toggleMute() {
    muted = !muted;
    ctx.send('mute', { type: 'mute', muted });
    paintMute();
  }
  const paintMute = () => {
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.innerHTML = `${icon(muted ? 'volumeOff' : 'volume', 15)}<span>${muted ? 'Muted' : 'Mute'}</span>`;
    vol.el.classList.toggle('muted', muted);
    volVal.classList.toggle('text', muted);
    volVal.innerHTML = muted ? '<span class="danger">Muted</span>' : pct(Number(vol.el.value), vmax);
  };
  const volumeCard = el('div', { class: 'card quick-card' },
    cardHead('volume', 'Volume', 'Headset output', volVal),
    el('div', { class: 'quick-control' }, vol.el,
      el('div', { class: 'quick-foot' }, muteBtn, el('span', { class: 'muted-text' }, 'Ctrl+M'))));

  // Balance (drawn like G Hub: game on the left, voice on the right; the raw value runs the other way)
  const balVal = el('div', { class: 'card-value text' });
  let bmax = 12;
  const centerBtn = el('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
    bal.el.focus();
    bal.el.value = String(bmax / 2);
    bal.el.dispatchEvent(new Event('input'));
  } }, 'Center');
  const gameLbl = el('span', {}, ic('gamepad', 14), 'Game');
  const voiceLbl = el('span', {}, 'Voice', ic('chat', 14));
  const balWords = (pos) => {
    const c = bmax / 2;
    return pos === c ? ['Even', ''] : pos < c ? ['More game', `+${c - pos}`] : ['More voice', `+${pos - c}`];
  };
  const bal = slider({ min: 0, max: 12, label: 'Game and voice chat balance', className: 'range center', quiet: () => ctx.quiet('balance'),
    valueText: (pos) => { const [w, n] = balWords(pos); return n ? `${w}, ${n.slice(1)} of ${bmax / 2}` : w; },
    onPreview: (pos) => {
      const [w, n] = balWords(pos);
      balVal.replaceChildren(w, n ? el('span', { class: 'of' }, n) : '');
      gameLbl.classList.toggle('lead', pos < bmax / 2);
      voiceLbl.classList.toggle('lead', pos > bmax / 2);
      centerBtn.style.visibility = pos === bmax / 2 ? 'hidden' : 'visible';
    },
    onChange: (pos) => ctx.send('balance', { type: 'balance', value: bmax - pos }) });
  bal.el.addEventListener('dblclick', () => centerBtn.click());
  const balanceCard = el('div', { class: 'card quick-card' },
    cardHead('signal', 'Balance', 'Game vs. voice chat', balVal),
    el('div', { class: 'quick-control' }, bal.el, el('div', { class: 'quick-foot balance-labels' }, gameLbl, centerBtn, voiceLbl)));

  // Sidetone
  const sideVal = el('div', { class: 'card-value' });
  let smax = 6;
  const ticks = el('div', { class: 'ticks', 'aria-hidden': 'true' });
  const side = slider({ min: 0, max: 6, label: 'Sidetone', quiet: () => ctx.quiet('sidetone'),
    valueText: (v) => (v === 0 ? 'Off' : `${v} of ${smax}`),
    onPreview: (v) => {
      sideVal.classList.toggle('text', v === 0);
      sideVal.replaceChildren(...(v === 0 ? ['Off'] : [String(v), el('span', { class: 'of' }, `/${smax}`)]));
      [...ticks.children].forEach((t, i) => t.classList.toggle('on', i === v));
    },
    onChange: (v) => ctx.send('sidetone', { type: 'sidetone', step: v }) });
  const sidetoneCard = el('div', { class: 'card quick-card' },
    cardHead('ear', 'Sidetone', 'Hear your own voice', sideVal),
    el('div', { class: 'quick-control' }, side.el, el('div', { class: 'quick-foot' }, ticks)));

  // Sound profiles: both EQ curves at a glance, with one-click switching
  const profile = (instance, title, iconName, target) => {
    const key = `eq:${instance}`;
    const curve = el('div', { class: 'mini' });
    let current = null;
    const chips = presetChips({
      label: `${title} presets`,
      limitCustom: 3,
      onCurated: (i, n) => { ctx.send(key, { type: 'eqCurated', instance, preset: i }); chips.update(current, n, false); },
      onCustom: (p) => { ctx.send(key, { type: 'eqCustom', id: p.id }); chips.update(current, p.name, false); },
    });
    const card = el('div', { class: 'card profile' },
      cardHead(iconName, title, null, el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go(target) }, 'Edit', ic('chevron', 14))),
      curve, chips.el);
    return {
      el: card,
      update(v) {
        current = v;
        if (ctx.quiet(key)) return;
        const flat = v.gainsDb.every((g) => Math.abs(g) < 0.05);
        curve.innerHTML = miniCurve(`mini${instance}`, v.frequencies, v.gainsDb, { gainMin: v.gainMinDb, gainMax: v.gainMaxDb }) + (flat ? '<span class="flat">Flat</span>' : '');
        chips.update(v, v.matches, false);
      },
    };
  };
  const hpProfile = profile(1, 'Headphones EQ', 'headphones', 'headphones');
  const micProfile = profile(0, 'Microphone EQ', 'mic', 'microphone');
  let gate = null;
  let gateSig = '';

  const gateHost = el('div', { class: 'gate-host' });
  const gateCard = el('div', { class: 'card gate-row' },
    el('div', { class: 'card-title' }, ic('wave', 18), 'Noise gate'),
    el('div', { class: 'gate-desc' }, 'Mic silence between words'),
    gateHost,
    el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go('microphone') }, 'Details', ic('chevron', 14)));

  const nudge = el('div', { class: 'nudge', hidden: true, role: 'region', 'aria-label': 'Audio setup tip' });
  onAudio(({ status, busy }) => {
    const show = !!status?.supported && status.cardFound && !status.active && localStorage.getItem('audioNudgeDismissed') !== '1';
    nudge.hidden = !show;
    if (!show) return;
    nudge.replaceChildren(
      ic('info', 16),
      el('span', {}, 'Game and voice chat share one channel here, so the balance can’t separate them.'),
      el('button', { class: 'btn sm primary', type: 'button', disabled: !!busy, onclick: () => runAudio('setup') },
        busy === 'setup' ? [el('span', { class: 'spinner sm' }), 'Setting up…'] : 'Split them'),
      el('button', { class: 'btn ghost sm', type: 'button', onclick: () => ctx.go('settings') }, 'Details'),
      el('button', { class: 'btn ghost sm icon-only', type: 'button', 'aria-label': 'Dismiss tip', title: 'Dismiss',
        onclick: () => { localStorage.setItem('audioNudgeDismissed', '1'); notifyAudio(); }, html: icon('x', 15) }));
  });

  const node = el('section', { class: 'page' },
    el('div', { class: 'stack' },
      nudge,
      hero,
      el('div', { class: 'grid-3' }, volumeCard, balanceCard, sidetoneCard),
      el('div', { class: 'grid-2' }, hpProfile.el, micProfile.el),
      gateCard));

  return {
    el: node,
    toggleMute,
    update(s) {
      const n = s.device.name?.trim();
      const possessive = !!n && /['’]s?$/.test(n);
      name.textContent = !n ? s.device.model : possessive ? `${n} ${s.device.model}` : n;
      model.replaceChildren(...(n && !possessive ? [el('span', {}, s.device.model), el('span', { class: 'sep-dot' })] : []),
        el('span', { class: 'dot on' }), el('span', {}, 'Base station connected'));
      batteryVal.textContent = `${s.battery}%`;
      batteryBar.style.setProperty('--level', `${s.battery}%`);
      battery.classList.toggle('low', s.battery <= 20 && s.battery > 10);
      battery.classList.toggle('critical', s.battery <= 10);
      bt.textContent = s.bluetoothHost ? s.bluetoothHost.name : 'Not paired';
      bt.classList.toggle('dim', !s.bluetoothHost);
      bt.title = s.bluetoothHost ? `${s.bluetoothHost.name} (${s.bluetoothHost.address})` : '';
      const off = s.routing.inputs.filter((i) => i.muted).map((i) => INPUTS[i.name]?.label ?? cap(i.name));
      streamStat.textContent = s.routing.output.muted ? 'Muted'
        : `${pct(s.routing.output.gain, s.routing.maxGain)}${off.length === 1 ? ` · ${off[0]} muted` : off.length ? ` · ${off.length} muted` : ''}`;
      streamStat.title = off.length ? `Muted on the stream: ${off.join(', ')}` : '';
      sleepStat.textContent = s.sleep.minutes === 0 ? 'Never' : s.sleep.minutes === 60 ? '1 hour' : `${s.sleep.minutes} min`;

      vmax = s.volume.max;
      vol.el.max = String(vmax);
      vol.set(s.volume.level);
      if (!ctx.quiet('mute')) muted = s.volume.muted;
      paintMute();

      bmax = s.balance.max;
      bal.el.max = String(bmax);
      bal.set(bmax - s.balance.value);

      smax = s.sidetone.max;
      side.el.max = String(smax);
      if (ticks.children.length !== smax + 1) ticks.replaceChildren(...Array.from({ length: smax + 1 }, (_, i) => el('span', {}, i === 0 ? 'Off' : String(i))));
      side.set(s.sidetone.step);

      const [mic, hp] = s.equalizers;
      hpProfile.update(hp);
      micProfile.update(mic);
      const gs = s.noiseGate.supported.join();
      if (gs !== gateSig) {
        gateSig = gs;
        const ordered = [...s.noiseGate.supported].sort((a, b) => GATE_ORDER.indexOf(a) - GATE_ORDER.indexOf(b));
        gate = segmented({ label: 'Noise gate', full: true, options: ordered.map((g) => ({ value: g, label: GATES[g]?.label ?? cap(g) })),
          onChange: (v) => ctx.send('gate', { type: 'noiseGate', value: v }) });
        gateHost.replaceChildren(gate.el);
      }
      if (!ctx.quiet('gate')) gate.set(String(s.noiseGate.value));
    },
  };
}

// ---------------------------------------------------------------- equalizer panel (shared)

function eqPanel(instance, { title, noun, head, hint }) {
  const key = `eq:${instance}`;
  let view = null;
  let base = null; // { name, gains } of the preset the current curve started from
  let unsaved = null; // the last curve that matched no preset, so the Custom chip can bring it back
  const graph = eqGraph({
    id: `eq${instance}`,
    label: `${title} bands`,
    onInput: (gains) => {
      ctx.send(key, { type: 'eqGains', instance, gainsDb: gains });
      unsaved = gains;
      paint(null);
    },
    onCommit: (gains) => ctx.send(key, { type: 'eqGains', instance, gainsDb: gains }),
  });
  const chips = presetChips({
    label: `${title} presets`,
    onCurated: (i, n) => { ctx.send(key, { type: 'eqCurated', instance, preset: i }); paint(n); },
    onCustom: (p) => { ctx.send(key, { type: 'eqCustom', id: p.id }); paint(p.name); },
    onRestore: () => {
      if (!unsaved) return;
      ctx.send(key, { type: 'eqGains', instance, gainsDb: unsaved });
      graph.set(view.frequencies, unsaved);
      paint(null);
    },
    onDelete: (p) => remove(p),
  });
  const note = el('span', { class: 'eq-note' });
  const saveBtn = el('button', { class: 'btn sm', type: 'button', onclick: () => save() }, ic('save', 15), 'Save as preset');
  const flatBtn = el('button', { class: 'btn ghost sm', type: 'button', onclick: () => flatten() }, ic('reset', 15), 'Flatten');

  function paint(active) {
    if (!view) return;
    chips.update(view, active, !!unsaved && !sameGains(unsaved, view.gainsDb));
    const editing = active === null && base && !sameGains(base.gains, graph.gains);
    graph.setGhost(editing ? base.gains : null);
    note.replaceChildren(...(editing
      ? [el('span', { class: 'ghost-key', 'aria-hidden': 'true', html: '<svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3"/></svg>' }), `${base.name}, the preset you started from`]
      : [hint]));
  }

  function flatten() {
    if (!view) return;
    const before = graph.gains;
    const zeros = view.frequencies.map(() => 0);
    ctx.send(key, { type: 'eqGains', instance, gainsDb: zeros });
    graph.set(view.frequencies, zeros);
    toast('Flattened the curve', { action: { label: 'Undo', run: () => { ctx.send(key, { type: 'eqGains', instance, gainsDb: before }); graph.set(view.frequencies, before); } }, timeout: 6000 });
  }

  async function save() {
    if (!view) return;
    const gains = graph.gains;
    const reserved = view.curated.map((n) => n.toLowerCase());
    const name = await prompt({
      title: 'Save preset',
      body: `Keep this ${noun} curve so you can switch back to it with one click.`,
      label: 'Preset name',
      placeholder: 'e.g. Footsteps',
      validate: (n) => {
        if (reserved.includes(n.toLowerCase())) return { hint: 'A built-in preset already uses that name.', block: true };
        if (view.custom.some((p) => p.name.toLowerCase() === n.toLowerCase())) return { hint: 'This replaces your preset with the same name.', confirm: 'Replace' };
        return null;
      },
    });
    if (!name) return;
    const existing = view.custom.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const res = await ctx.send('presets', { type: 'savePreset', id: existing?.id, instance, name, gainsDb: gains }, { coalesce: false });
    if (res.connected && !res.error) toast(`Saved “${name}”`);
  }

  async function remove(p) {
    const res = await ctx.send('presets', { type: 'deletePreset', id: p.id }, { coalesce: false });
    if (!res.connected || res.error) return;
    toast(`Deleted “${p.name}”`, {
      action: { label: 'Undo', run: () => ctx.send('presets', { type: 'savePreset', id: p.id, instance: p.instance, name: p.name, gainsDb: p.gainsDb }, { coalesce: false }) },
      timeout: 6000,
    });
  }

  const warn = el('div', { class: 'note warn', hidden: true });
  const node = el('div', { class: 'card' },
    head ?? null,
    warn,
    chips.el,
    graph.el,
    el('div', { class: 'eq-foot' }, note, el('div', { class: 'actions' }, flatBtn, saveBtn)));

  return {
    el: node,
    update(v, presetsError) {
      view = v;
      warn.hidden = !presetsError;
      if (presetsError) warn.replaceChildren(ic('alert', 16), el('span', {}, `Custom presets are unavailable: ${presetsError}. Fix or move the file and they’ll come back.`));
      if (ctx.quiet(key)) {
        chips.update(v, undefined, false);
        return;
      }
      graph.set(v.frequencies, v.gainsDb, { min: v.gainMinDb, max: v.gainMaxDb });
      if (v.matches) base = { name: v.matches, gains: v.gainsDb };
      else unsaved = v.gainsDb;
      paint(v.matches);
    },
  };
}

const EQ_HINT = 'Drag a point, or use the arrow keys. Shift for fine steps, 0 resets a band.';

// ---------------------------------------------------------------- headphones

function headphonesPage() {
  const panel = eqPanel(1, { title: 'Headphones EQ', noun: 'headphone EQ', hint: EQ_HINT });
  return {
    el: pageShell('Headphones', 'How everything sounds in the headset: game, chat and Bluetooth. Also applies to the stream output.', panel.el),
    update: (s) => panel.update(s.equalizers[1], s.presetsError),
  };
}

// ---------------------------------------------------------------- microphone

const GATES = {
  off: { label: 'Off', desc: 'Sends everything the mic hears.', icon: 'mic' },
  night: { label: 'Night', desc: 'Quiet room, speaking softly.', icon: 'moonStar' },
  home: { label: 'Home', desc: 'Some background noise, normal voice.', icon: 'home' },
  tournament: { label: 'Tournament', desc: 'Loud surroundings, raised voice.', icon: 'trophy' },
};
const GATE_ORDER = ['off', 'night', 'home', 'tournament', 'stream', 'pushToTalk', 'clearVoice'];

/** How often the mic's dB number may change: 10 times a second (frames come every 33 ms, so every third). */
const NUMBER_MS = 90;

/**
 * The live mic level under the gate choices. The headset doesn't say where its gate thresholds are,
 * so nothing here pretends to: it shows the level and when the mic sends silence, which is what a
 * closed gate does (measured on the A50 X: digital silence, against about -60 dBFS of room noise).
 */
function micLevels() {
  const head = levelsBar({ live: 'Measuring your mic. Nothing is recorded.' });
  const meter = ledMeter({ label: 'Mic input level' });
  const gate = gateWatch();
  const state = el('span', { class: 'gate-state' });
  const value = el('span', { class: 'mic-db' });
  const hint = el('p', { class: 'mic-hint' });
  const panel = el('div', { class: 'mic-live' },
    el('div', { class: 'mic-live-top' }, state, value),
    meter.el,
    hint);
  let gateValue = null;
  let silentFor = 0;
  let numberAt = 0;
  let live = false;
  let last = '';
  const paint = (silent) => {
    const off = gateValue === 'off';
    // A closed gate and a muted mic both send silence; after a while, say it could be either.
    const [cls, text] = !live ? ['', 'Not measuring']
      : silent === null ? ['', '…']
      : off ? (silentFor > 30 ? ['', 'No sound: is the mic muted?'] : ['', 'Gate off'])
      : !silent ? ['open', 'Gate open']
      : silentFor > 90 ? ['closed', 'Silent: gate closed, or mic muted'] : ['closed', 'Gate closed'];
    const tip = off
      ? 'With the gate off, everything the mic hears goes out, room noise included. Pick a gate and talk to see where it cuts in.'
      : 'When every dot goes dark, the gate has cut your mic to silence. The headset doesn’t say how loud you need to be to open it, so talk normally and compare settings.';
    // Called every frame: only touch the DOM when something changed.
    if (state.textContent !== text) state.textContent = text;
    if (state.className !== `gate-state ${cls}`) state.className = `gate-state ${cls}`;
    if (hint.textContent !== tip) hint.textContent = tip;
  };
  const reset = () => {
    meter.clear();
    gate.reset();
    value.textContent = '';
    silentFor = 0;
    paint(null);
  };
  onLevels((st) => {
    panel.hidden = st !== 'live' && st !== 'background';
    if (st === last) return;
    last = st;
    live = st === 'live';
    panel.classList.toggle('idle', !live);
    reset();
  });
  return {
    els: [head, panel],
    reset,
    setGate(v) {
      if (v === gateValue) return;
      gateValue = v;
      paint(null);
    },
    /** v: [level, peak hold, raw peak] in dBFS. */
    levels([level, hold, peak]) {
      const silent = gate.push(peak);
      silentFor = silent ? silentFor + 1 : 0;
      // The dots go dark with the gate, instead of falling slowly through the silence.
      meter.set(level, hold, silent);
      // The number would change about 30 times a second, too fast to read, and each change lays out and
      // repaints it: update it 10 times a second (the dots still move every frame). Silence shows at once.
      const db = silent ? '—' : dbText(level);
      const at = performance.now();
      if (value.textContent !== db && (at - numberAt >= NUMBER_MS || silent || value.textContent === '—')) {
        value.textContent = db;
        numberAt = at;
      }
      paint(silent);
    },
  };
}

function microphonePage() {
  let gates = null;
  let sig = '';
  const gateHost = el('div');
  const buildGates = (supported) => {
    const s = supported.join();
    if (s === sig) return;
    sig = s;
    const ordered = [...supported].sort((a, b) => GATE_ORDER.indexOf(a) - GATE_ORDER.indexOf(b));
    gates = choiceCards({
      label: 'Noise gate',
      options: ordered.map((g) => ({ value: g, ...(GATES[g] ?? { label: cap(g.replace(/([A-Z])/g, ' $1').toLowerCase()), desc: '', icon: 'wave' }) })),
      onChange: (v) => { ctx.send('gate', { type: 'noiseGate', value: v }); live.setGate(v); },
    });
    gateHost.replaceChildren(gates.el);
  };
  const live = micLevels();
  const gateCard = el('div', { class: 'card' },
    cardHead('wave', 'Noise gate', 'Silences the mic between words, so keyboards and fans stay out of the call.'),
    gateHost,
    el('div', { class: 'mic-levels' }, live.els));
  const panel = eqPanel(0, {
    title: 'Mic EQ',
    noun: 'mic EQ',
    head: cardHead('mic', 'Mic equalizer', 'Shapes how your voice sounds to others.'),
    hint: EQ_HINT,
  });
  const level = el('div', { class: 'note' }, ic('info', 16),
    el('span', {}, 'Recording level is your system’s input volume for the A50 X (PipeWire or PulseAudio settings). The headset has no separate mic gain.'));
  return {
    el: pageShell('Microphone', 'How others hear you.', el('div', { class: 'stack' }, gateCard, panel.el, level)),
    levels: (frame) => frame.mic && live.levels(frame.mic),
    resetLevels: () => live.reset(),
    update(s) {
      buildGates(s.noiseGate.supported);
      if (!ctx.quiet('gate')) gates.set(String(s.noiseGate.value));
      live.setGate(String(s.noiseGate.value));
      panel.update(s.equalizers[0], s.presetsError);
    },
  };
}

// ---------------------------------------------------------------- stream mix

const INPUTS = {
  mic: { label: 'Mic', desc: 'Your voice', icon: 'mic' },
  game: { label: 'Game', desc: 'PC or console', icon: 'gamepad' },
  voice: { label: 'Voice chat', desc: 'Discord, party chat', icon: 'chat' },
  bluetooth: { label: 'Bluetooth', desc: 'Phone audio', icon: 'phone' },
};
const INPUT_ORDER = ['mic', 'game', 'voice', 'bluetooth'];

/**
 * Live meter for each strip: what comes in, before the strip's fader; for the output, what the
 * stream port sends. Bluetooth audio never reaches this computer, so it has none.
 */
const STRIP_METERS = {
  out: { key: 'streamOut', label: 'Stream output level', title: 'What your stream gets (A50 X Stream Out)' },
  mic: { key: 'mic', label: 'Mic input level', title: 'Your mic, before this slider' },
  game: { key: 'game', label: 'Game input level', title: 'What this computer plays to A50 X Game, before its volume and this slider. Console audio doesn’t show here.' },
  voice: { key: 'voice', label: 'Voice chat input level', title: 'What this computer plays to A50 X Voice, before its volume and this slider' },
};
const NO_METER = 'No level meter: Bluetooth audio doesn’t pass through this computer';
/** Inputs that can't be metered (null) or aren't known (no entry). */
const stripMeter = (name) => (name === 'bluetooth' ? null : STRIP_METERS[name]);

function strip({ key, name, desc, iconName, master, scale, meter, onGain, onMute }) {
  const val = el('div', { class: 'strip-val' });
  let max = 32;
  const fader = slider({ min: 0, max: 32, className: 'fader', label: `${name} level on stream`, quiet: () => ctx.quiet(key) || ctx.quiet(`${key}:mute`),
    valueText: (v) => pct(v, max), onPreview: (v) => paintVal(v), onChange: onGain });
  const mute = muteButton({ label: master ? 'Mute stream output' : `Mute ${name.toLowerCase()} on stream`, onChange: (m) => { paint(m); onMute(m); } });
  const bar = meter ? levelBar({ label: meter.label, description: meter.title, className: 'strip-lvl' }) : null;
  const node = el('div', { class: `strip${master ? ' master' : ''}` },
    el('div', { class: 'strip-icon' }, ic(iconName, 20)),
    el('div', {}, el('div', { class: 'strip-name' }, name), el('div', { class: 'strip-desc' }, desc)),
    el('div', { class: 'fader-wrap' },
      scale ? el('div', { class: 'fader-scale', 'aria-hidden': 'true' }, ...['100', '75', '50', '25', '0'].map((t) => el('span', {}, t))) : null,
      fader.el,
      bar?.el ?? (meter === null ? el('div', { class: 'strip-lvl none', title: NO_METER }) : null)),
    val,
    mute.el);
  const paintVal = (v) => {
    val.textContent = mute.muted ? 'Muted' : pct(v, max);
    val.title = mute.muted ? `Level ${pct(v, max)} (muted)` : '';
  };
  const paint = (m) => {
    node.classList.toggle('is-muted', m);
    fader.el.classList.toggle('muted', m);
    paintVal(Number(fader.el.value));
  };
  return {
    el: node,
    meterKey: meter?.key,
    /** v: [level, peak hold, raw peak] in dBFS, or null to clear. */
    levels(v) {
      if (!bar) return;
      if (v) bar.set(v[0], v[1]);
      else bar.clear();
    },
    update(gain, muted, maxGain) {
      max = maxGain;
      fader.el.max = String(maxGain);
      fader.set(gain);
      if (!ctx.quiet(`${key}:mute`)) mute.set(muted);
      paint(mute.muted);
    },
  };
}

function mixPage() {
  const console_ = el('div', { class: 'console' });
  const strips = new Map();
  let sig = '';
  const head = levelsBar({
    live: 'Measuring your mic, this computer’s audio and what your stream gets. Nothing is recorded.',
  });
  const card = el('div', { class: 'card mix-card' }, head, console_);
  onLevels((state) => {
    card.classList.toggle('metered', state === 'live' || state === 'background');
    card.classList.toggle('levels-idle', state !== 'live');
    if (state !== 'live') for (const st of strips.values()) st.levels(null);
  });
  return {
    el: pageShell('Stream Mix', 'What the base station sends to your capture card or streaming PC. It doesn’t change what you hear.', card),
    levels(frame) {
      for (const st of strips.values()) if (st.meterKey && frame[st.meterKey]) st.levels(frame[st.meterKey]);
    },
    resetLevels: () => { for (const st of strips.values()) st.levels(null); },
    update(s) {
      const inputs = [...s.routing.inputs].sort((a, b) => INPUT_ORDER.indexOf(a.name) - INPUT_ORDER.indexOf(b.name));
      const nextSig = inputs.map((i) => `${i.index}:${i.name}`).join();
      if (nextSig !== sig) {
        sig = nextSig;
        strips.clear();
        const out = strip({ key: 'mix:out', name: 'Output', desc: 'Overall level', iconName: 'signal', master: true, scale: true, meter: STRIP_METERS.out,
          onGain: (g) => ctx.send('mix:out', { type: 'routingOutput', gain: g }),
          onMute: (m) => ctx.send('mix:out:mute', { type: 'routingOutput', muted: m }) });
        strips.set('out', out);
        const ins = inputs.map((i) => {
          const meta = INPUTS[i.name] ?? { label: cap(i.name), desc: '', icon: 'wave' };
          const st = strip({ key: `mix:${i.index}`, name: meta.label, desc: meta.desc, iconName: meta.icon, meter: stripMeter(i.name),
            onGain: (g) => ctx.send(`mix:${i.index}`, { type: 'routingInput', index: i.index, gain: g }),
            onMute: (m) => ctx.send(`mix:${i.index}:mute`, { type: 'routingInput', index: i.index, muted: m }) });
          strips.set(i.index, st);
          return st.el;
        });
        console_.replaceChildren(out.el, ...ins);
      }
      strips.get('out').update(s.routing.output.gain, s.routing.output.muted, s.routing.maxGain);
      console_.classList.toggle('silenced', s.routing.output.muted);
      for (const i of s.routing.inputs) strips.get(i.index)?.update(i.gain, i.muted, s.routing.maxGain);
    },
  };
}

// ---------------------------------------------------------------- settings

function settingsPage() {
  const setting = (iconName, title, desc, control) =>
    el('div', { class: 'setting' },
      el('div', {}, el('div', { class: 't' }, title), el('div', { class: 'd' }, desc)),
      el('div', { class: 'control' }, control));

  let sleep = null;
  let sleepSig = '';
  const sleepHost = el('div', { style: { width: '100%' } });
  const tones = segmented({ label: 'Headset tones', full: true,
    options: [{ value: 'all', label: 'All' }, { value: 'minimal', label: 'Minimal' }, { value: 'none', label: 'None' }],
    onChange: (v) => ctx.send('tones', { type: 'tones', value: v }) });
  const brightVal = el('span', { class: 'val' });
  const bright = slider({ min: 0, max: 100, label: 'Base station brightness', quiet: () => ctx.quiet('brightness'),
    valueText: (v) => `${v}%`, onPreview: (v) => (brightVal.textContent = `${v}%`),
    onChange: (v) => ctx.send('brightness', { type: 'brightness', percent: v }) });

  const facts = el('div', { class: 'facts' });
  const presetsPath = window.a50x.platform === 'darwin' ? '~/Library/Application Support/logitech-manager/presets.json' : '~/.config/logitech-manager/presets.json';

  const node = pageShell('Settings', 'Headset, base station and app preferences.',
    el('div', { class: 'stack' },
      el('div', { class: 'card' },
        cardHead('headphones', 'Headset', null),
        setting('moon', 'Sleep after', 'Turn the headset off when it’s idle this long.', sleepHost),
        setting('bell', 'Tones', 'Beeps and prompts the headset plays, such as power and battery alerts.', tones.el)),
      el('div', { class: 'card' },
        cardHead('plug', 'Base station', null),
        setting('sunDim', 'Display brightness', 'Brightness of the base station’s lights.',
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%' } }, bright.el, brightVal))),
      keepCard(),
      audioCard(),
      appCard(),
      el('div', { class: 'card' }, cardHead('info', 'About this headset', null), facts),
      el('div', { class: 'note' }, ic('save', 16), el('span', {}, 'Custom EQ presets are saved on this computer in ', el('code', {}, presetsPath), '. Everything else lives on the headset.'))));

  return {
    el: node,
    update(s) {
      const sg = s.sleep.choices.join();
      if (sg !== sleepSig) {
        sleepSig = sg;
        sleep = segmented({ label: 'Sleep after', full: true,
          options: s.sleep.choices.map((m) => ({ value: m, label: m === 0 ? 'Never' : m === 60 ? '1 hour' : `${m} min` })),
          onChange: (v) => ctx.send('sleep', { type: 'sleep', minutes: Number(v) }) });
        sleepHost.replaceChildren(sleep.el);
      }
      if (!ctx.quiet('sleep')) sleep.set(s.sleep.minutes);
      if (!ctx.quiet('tones')) tones.set(s.tones);
      bright.set(s.brightness);
      const d = s.device;
      const rows = [
        ['Name', d.name || '—'],
        ['Model', d.model],
        ['Firmware', d.firmware.version, 'mono'],
        ['Serial number', d.serial, 'mono'],
        ['Hardware revision', String(d.hardwareRevision), 'mono'],
        ['Bluetooth', s.bluetoothHost ? s.bluetoothHost.name : 'Not paired', s.bluetoothHost ? '' : 'dim'],
      ];
      facts.replaceChildren(...rows.map(([k, v, cls = '']) =>
        el('div', { class: 'fact' }, el('span', { class: 'k' }, k), el('span', { class: `v ${cls}`, title: v }, v))));
    },
  };
}

function audioCard() {
  const card = el('div', { class: 'card audio-card', hidden: true });
  const device = (name, role) => el('div', { class: 'audio-dev' }, el('span', { class: 'n' }, name), el('span', { class: 'r' }, role));
  onAudio(({ status, busy }) => {
    card.hidden = !status;
    if (!status) return;
    const button = (op, label, primary) =>
      el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', disabled: !!busy, onclick: () => runAudio(op) },
        busy === op ? [el('span', { class: 'spinner sm' }), op === 'undo' ? 'Turning off…' : 'Setting up…'] : label);
    const head = (state) => cardHead('mixer', 'Game and chat audio', null, state ? el('span', { class: `pill ${state[0]}` }, state[1]) : null);
    if (!status.supported) {
      card.replaceChildren(head(null), el('p', { class: 'audio-text' }, `Not available: ${status.reason}`));
    } else if (!status.cardFound && !status.active) {
      card.replaceChildren(head(null), el('p', { class: 'audio-text' }, 'The base station’s audio device isn’t showing up in PipeWire, so there’s nothing to split right now.'));
    } else if (status.active && status.installed === 'current') {
      card.replaceChildren(head(['on', 'On']),
        el('p', { class: 'audio-text' }, 'The base station shows up as separate outputs, so the Game/Voice balance works like it does on Windows.'),
        el('div', { class: 'audio-devs' },
          device('A50 X Game', status.defaultOutputIsGame ? 'Default output: games, browser, music' : 'Games, browser, music'),
          device('A50 X Voice', 'Voice chat: Discord, TeamSpeak, Mumble…'),
          device('A50 X Mic', 'Your microphone'),
          device('A50 X Stream Out', 'The Stream Mix, as a source for OBS')),
        el('div', { class: 'audio-foot' },
          el('span', {}, 'Move an app to the other output in your sound settings and it stays there.'),
          button('undo', 'Turn off')));
    } else if (status.installed === 'partial' || status.installed === 'outdated') {
      card.replaceChildren(head(['warn', status.installed === 'partial' ? 'Incomplete' : 'Update available']),
        el('p', { class: 'audio-text' }, status.installed === 'partial'
          ? 'Part of the audio setup is missing, so it may not work. Repair it, or turn it off.'
          : 'A newer version of the audio setup comes with this app.'),
        el('div', { class: 'audio-foot' }, el('span'), el('div', { class: 'actions' }, button('undo', 'Turn off'), button('setup', status.installed === 'partial' ? 'Repair' : 'Update', true))));
    } else {
      card.replaceChildren(head(['off', 'Off']),
        el('p', { class: 'audio-text' },
          'On this computer everything plays through the base station’s chat channel, so the Game/Voice balance can’t tell game audio from voice chat. ',
          'Split it into ', el('b', {}, 'A50 X Game'), ' for everything and ', el('b', {}, 'A50 X Voice'), ' for chat apps like Discord.'),
        el('div', { class: 'audio-foot' },
          el('span', {}, 'Changes your PipeWire setup for your user only. Audio cuts out for a second.'),
          button('setup', 'Split game and chat audio', true)));
    }
  });
  return card;
}

// ------------------------------------------------------------------ offline

function offlineView(info) {
  const searching = el('div', { class: 'status' }, el('span', { class: 'spinner' }), 'Looking for the base station');
  const box = (title, body, ...extra) =>
    el('div', { class: 'empty' }, el('div', { class: 'empty-box' },
      el('div', { html: headsetArt('empty', { lit: false }) }),
      el('h1', {}, title), el('p', {}, body), ...extra));
  switch (info.reason) {
    case 'permission':
      if (window.a50x.platform === 'linux') return accessScreen();
      return box('Allow access to the base station', info.error ?? 'Your user can’t open the base station.',
        el('div', { class: 'status' }, el('span', { class: 'spinner' }), 'Waiting for access'));
    case 'unresponsive':
      return box('The headset isn’t answering',
        'The base station is connected but the headset didn’t respond. Turn it on and keep it in range of the base station.',
        searching);
    case 'error':
      return box('Couldn’t connect', info.error ?? 'Something went wrong talking to the base station.', searching);
    default:
      return box('Connect your A50 X',
        'Plug the base station into this computer with USB. Settings travel through the base station, so the headset’s Bluetooth link alone isn’t enough.',
        searching);
  }
}

// ------------------------------------------------------------------ start

// The tray's "Settings…" and the keep-settings notifications: the headset's Settings page has the
// app settings and what was restored, so it goes first; the mouse's has the app settings too.
initAppSettings({
  openSettings: () => {
    if (snap) {
      selectDevice('headset');
      show('settings', { focus: true });
    } else if (mouse.online) {
      selectDevice('mouse');
      mouse.show('settings', { focus: true });
    }
  },
});
mouse.setActive(device === 'mouse');
// Access was just allowed: connect both now instead of at the next check.
onAccessAllowed(() => { void refresh(); void mouse.refresh(); });
renderNav();
renderDeviceCard();
renderFoot();
if (device === 'mouse') mountMouse();
else mountHeadset();
void refresh();
// Fresh battery reading every minute; everything else arrives as device events.
setInterval(() => { if (snap && writer.idle) void refresh(); }, 60000);
