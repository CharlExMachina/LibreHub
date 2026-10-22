// The app's own settings, shown on the Settings page: keeping the headset's settings, starting at
// login and updates. Kept apart from the headset settings because they live on this computer.
import { icon } from './icons.js';
import { el, toast, toggle } from './ui.js';

const ic = (name, size) => el('span', { style: { display: 'contents' }, html: icon(name, size) });
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const LABELS = {
  sidetone: 'sidetone',
  balance: 'game/voice balance',
  volume: 'volume',
  headphonesEq: 'headphones EQ',
  micEq: 'mic EQ',
  noiseGate: 'noise gate',
  mix: 'stream mix',
  headset: 'sleep timer, tones and brightness',
};
const WHEN = {
  startup: 'when the app started',
  wake: 'while the computer was asleep',
  unlock: 'while the computer was locked',
  reconnect: 'while the headset was disconnected',
  'follow-up': 'shortly after the last check',
};
const named = (groups) => list((groups ?? []).map((g) => LABELS[g] ?? g));
const failedText = (e) => (e.error ? `Couldn’t check the headset: ${e.error}` : `Couldn’t restore the ${named(e.failed?.map((f) => f.group))}`);

let state = null;
const syncs = new Set();
const sync = () => syncs.forEach((fn) => fn());

async function load() {
  state = await window.a50x.app.get();
  sync();
}

async function change(patch) {
  const res = await window.a50x.app.set(patch);
  state = res.state;
  sync();
  if (res.error) toast(`Couldn’t change that: ${res.error}`, { kind: 'error' });
}

/** `openSettings` shows the Settings page (the tray menu and notifications ask for it). */
export function initAppSettings({ openSettings }) {
  window.a50x.app.onEvent((what, entry) => {
    if (what === 'open-settings') openSettings();
    if (what === 'update' && state) {
      state = { ...state, update: entry };
      sync();
    }
    if (what !== 'checked') return;
    void load();
    // Main only sends a desktop notification when the window isn't in front; say it here instead.
    if (entry.trigger === 'manual' || !document.hasFocus()) return;
    if (entry.outcome === 'restored') toast(`${cap(named(entry.restored))} changed ${WHEN[entry.trigger]}. Put back and confirmed.`, { timeout: 8000 });
    else if (entry.outcome === 'failed') toast(failedText(entry), { kind: 'error', timeout: 8000 });
  });
  void load();
}

const setting = (id, title, desc, control) =>
  el('div', { class: 'setting' },
    el('div', {}, el('div', { class: 't', id: `${id}-t` }, title), desc ? el('div', { class: 'd', id: `${id}-d` }, desc) : null),
    el('div', { class: 'control' }, control));

function labelledToggle(id, onChange) {
  const t = toggle({ onChange });
  t.el.setAttribute('aria-labelledby', `${id}-t`);
  t.el.setAttribute('aria-describedby', `${id}-d`);
  return t;
}

const cardHead = (iconName, title, right) =>
  el('div', { class: 'card-head' }, el('div', { class: 'card-title' }, ic(iconName, 18), title), right ?? null);

export function keepCard() {
  const keep = toggle({ label: 'Keep my headset settings', onChange: (on) => void change({ keepSettings: on }) });
  const notifyT = labelledToggle('s-notify', (on) => void change({ notifyRestores: on }));
  const loginNote = el('div', { class: 'note warn' }, ic('info', 16),
    el('span', {}, 'This only works while Libre Hub is running. Start it when you log in so it’s there after a restart.'),
    el('button', { class: 'btn sm', type: 'button', onclick: () => void change({ openAtLogin: true }) }, 'Start at login'));
  const checkBtn = el('button', { class: 'btn sm primary', type: 'button', onclick: () => void checkNow() }, 'Check now');
  const rememberBtn = el('button', { class: 'btn sm ghost', type: 'button', onclick: () => void rememberNow() }, 'Keep what’s on the headset now');
  const body = el('div', { class: 'keep-body' },
    loginNote,
    setting('s-notify', 'Notify me when something is restored', 'Only when a check had to change something.', notifyT.el),
    el('div', { class: 'audio-foot' },
      el('span', {}, 'Changes you make here are kept as you make them.'),
      el('div', { class: 'actions' }, rememberBtn, checkBtn)));
  const card = el('div', { class: 'card' },
    cardHead('reset', 'Keep my headset settings', keep.el),
    el('p', { class: 'audio-text' },
      'If the headset’s settings change while you weren’t using Libre Hub, it puts yours back. It checks when the app starts, after the computer wakes up or unlocks, and when the headset reconnects. Only settings that changed are written, and the headset is read again to confirm them.'),
    body);

  let checking = false;
  async function checkNow() {
    if (checking) return;
    checking = true;
    sync();
    const res = await window.a50x.app.checkNow().catch((err) => ({ error: String(err?.message ?? err) }));
    checking = false;
    if (res.state) state = res.state;
    sync();
    const e = res.entry;
    if (res.error) toast(`Couldn’t check the headset: ${res.error}`, { kind: 'error' });
    else if (!e) toast('The headset isn’t connected. It’ll be checked when it connects.');
    else if (e.outcome === 'matched') toast('Everything was already the way you set it');
    else if (e.outcome === 'restored') toast(`Restored the ${named(e.restored)}, confirmed by reading the headset again`);
    else if (e.outcome === 'remembered') toast('Kept the headset’s current settings');
    else toast(failedText(e), { kind: 'error' });
  }

  async function rememberNow() {
    const res = await window.a50x.app.rememberNow().catch((err) => ({ error: String(err?.message ?? err) }));
    if (res.state) state = res.state;
    sync();
    if (res.error) toast(`Couldn’t read the headset: ${res.error}`, { kind: 'error' });
    else if (!res.entry) toast('The headset isn’t connected.');
    else toast('These are now the settings Libre Hub keeps');
  }

  syncs.add(() => {
    card.hidden = !state;
    if (!state) return;
    keep.set(state.prefs.keepSettings);
    notifyT.set(state.prefs.notifyRestores);
    body.hidden = !state.prefs.keepSettings;
    loginNote.hidden = !state.openAtLogin.supported || state.openAtLogin.enabled;
    checkBtn.disabled = checking || !state.connected;
    checkBtn.replaceChildren(...(checking ? [el('span', { class: 'spinner sm' }), 'Checking…'] : ['Check now']));
    rememberBtn.disabled = !state.connected;
  });
  sync();
  return card;
}

/** What the updater is doing, and the button that goes with it. */
function updateLine(u) {
  switch (u?.status) {
    case 'checking': return ['Checking for updates…', null];
    case 'latest': return ['You have the latest version.', 'check'];
    case 'downloading': return [`Downloading ${u.version}… ${u.percent}%`, null];
    case 'ready': return [`Version ${u.version} is ready. It’s installed when you quit, or restart now.`, 'install'];
    case 'error': return [`Couldn’t check for updates: ${u.error}.`, 'check'];
    case 'idle': return ['Checks GitHub for new releases every few hours.', 'check'];
    default: return ['Updates come with the AppImage. This copy runs from source.', null];
  }
}

/** What a manual check found, as a toast. */
function updateToast(u) {
  switch (u?.status) {
    case 'latest': return toast('You have the latest version.');
    case 'downloading': return toast(`Downloading version ${u.version}…`);
    case 'ready': return toast(`Version ${u.version} is ready. It’s installed when you quit.`,
      { action: { label: 'Restart to update', run: () => void window.a50x.app.installUpdate() }, timeout: 8000 });
    case 'error': return toast(`Couldn’t check for updates: ${u.error}.`, { kind: 'error', timeout: 8000 });
  }
}

/** A small button that checks for updates now instead of waiting for the next scheduled check. */
export function updateCheckButton() {
  const btn = el('button', { class: 'btn ghost sm icon-only', type: 'button', html: icon('refresh', 14) });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    state = await window.a50x.app.checkForUpdate();
    sync();
    updateToast(state.update);
  });
  syncs.add(() => {
    const status = state?.update?.status;
    btn.hidden = !status || status === 'off';
    const busy = status === 'checking' || status === 'downloading';
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
    const label = status === 'checking' ? 'Checking for updates…' : status === 'downloading' ? 'Downloading an update…' : 'Check for updates';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  });
  sync();
  return btn;
}

export function appCard() {
  const login = labelledToggle('s-login', (on) => void change({ openAtLogin: on }));
  const versionT = el('div', { class: 't', id: 's-version-t' });
  const versionD = el('div', { class: 'd', id: 's-version-d', 'aria-live': 'polite' });
  const updateBtn = el('button', { class: 'btn sm', type: 'button' });
  updateBtn.addEventListener('click', async () => {
    if (updateBtn.dataset.action === 'install') return void window.a50x.app.installUpdate();
    updateBtn.disabled = true;
    state = await window.a50x.app.checkForUpdate();
    sync();
  });
  const card = el('div', { class: 'card' },
    cardHead('power', 'Libre Hub'),
    setting('s-login', 'Start when you log in',
      'Runs in the system tray without opening this window. Closing the window keeps it there too; to quit, right-click the tray icon.',
      login.el),
    el('div', { class: 'setting' }, el('div', {}, versionT, versionD), el('div', { class: 'control' }, updateBtn)));
  syncs.add(() => {
    card.hidden = !state;
    if (!state) return;
    login.set(state.openAtLogin.enabled);
    login.el.disabled = !state.openAtLogin.supported;
    versionT.textContent = `Version ${state.version}`;
    const [text, action] = updateLine(state.update);
    versionD.textContent = text;
    updateBtn.hidden = !action;
    updateBtn.disabled = false;
    updateBtn.dataset.action = action ?? '';
    updateBtn.className = `btn sm${action === 'install' ? ' primary' : ''}`;
    updateBtn.textContent = action === 'install' ? 'Restart to update' : 'Check for updates';
  });
  sync();
  return card;
}
