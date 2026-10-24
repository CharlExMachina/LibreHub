// Linux: letting this user open the devices. Without a udev rule Linux won't let the app open the
// headset's base station or the mouse's receiver; one click installs it, after the desktop asks
// for the password (src/access/udev.ts). Both devices show the same screen, and Settings has a line
// to update or remove it.
import { headsetArt, mouseArt } from './art.js';
import { icon } from './icons.js';
import { codeBlock, confirmDialog, el, toast } from './ui.js';

const ic = (name, size) => el('span', { style: { display: 'contents' }, html: icon(name, size) });
const api = window.a50x.access;
/** Product ids in the rule → the device they let you use. */
const DEVICES = { '0b0b': 'A50 X', c547: 'G502 X PLUS', c095: 'G502 X PLUS' };
const named = (ids) => [...new Set(ids.map((id) => DEVICES[id] ?? `device ${id}`))].join(' and ');

let status = null;
let busy = false;
const listeners = new Set();
const allowedListeners = new Set();
const sync = () => listeners.forEach((fn) => fn());

async function load() {
  status = await api?.status().catch(() => null);
  sync();
}

/** Called once access was allowed, so the devices can connect right away. */
export function onAccessAllowed(fn) {
  allowedListeners.add(fn);
}

async function elevate(op) {
  if (busy) return null;
  busy = op;
  sync();
  const res = await api[op]().catch((err) => ({ outcome: 'failed', error: String(err?.message ?? err) }));
  busy = false;
  if (res.status) status = res.status;
  sync();
  if (res.outcome === 'done' && op === 'allow') allowedListeners.forEach((fn) => fn());
  return res;
}

/** Commands that do the same by hand, in a dialog (Settings, when there's no password dialog). */
async function commandsDialog(title, body) {
  const commands = await api.manual();
  const dlg = el('dialog', { class: 'commands-dialog', 'aria-labelledby': 'cmd-t' },
    el('form', { method: 'dialog' },
      el('h2', { id: 'cmd-t' }, title), el('p', {}, body), codeBlock(commands),
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', value: 'ok' }, 'Done'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** The screen a device shows while Linux won't let the app open it. */
export function accessScreen() {
  const root = el('div', { class: 'empty' });
  let shown = null; // the last attempt: null, or its outcome / error
  let details = false;
  let commands = null;
  const showCommands = async () => {
    commands = await api.manual().catch(() => null);
    paint();
  };
  const paint = () => {
    const allowBtn = (label) => el('button', { class: 'btn primary', type: 'button', disabled: !!busy,
      onclick: async () => {
        const res = await elevate('allow');
        if (!res) return;
        shown = res.outcome === 'done' ? null : res;
        if (res.outcome === 'done') toast('Access allowed. Libre Hub can use your devices now.');
        if (res.outcome === 'no-agent') await showCommands();
        paint();
      } },
    busy === 'allow' ? [el('span', { class: 'spinner sm' }), 'Waiting for your password…'] : [ic('shield', 16), label]);
    const moreBtn = el('button', { class: 'btn ghost', type: 'button', 'aria-expanded': String(details), onclick: () => { details = !details; paint(); } },
      'What does this change?');
    const explain = el('div', { class: 'access-more' },
      el('b', {}, 'What this changes: '),
      'it adds one file, ', el('code', {}, '/etc/udev/rules.d/70-libre-hub.rules'),
      ', which lets whoever is logged in at this computer use these Logitech devices. Nothing extra runs in the background. You can remove it in Settings. ',
      commands ? null : el('button', { class: 'text-link', type: 'button', onclick: () => void showCommands() }, 'Prefer the terminal? Show the commands.'));

    let title = 'One step before Libre Hub can use your devices';
    let body = 'Linux lets an app open the A50 X base station and the mouse’s receiver only after you allow it. You do this once, and it asks for your password.';
    let actions = [allowBtn('Allow access'), moreBtn];
    if (busy === 'allow') body = 'Waiting for your password…';
    else if (shown?.outcome === 'cancelled') {
      title = 'Libre Hub can’t use your devices yet';
      body = 'Nothing was changed. It needs your permission once to open them.';
      actions = [allowBtn('Try again'), moreBtn];
    } else if (shown?.outcome === 'no-agent') {
      title = 'Allow access from a terminal';
      body = 'There’s no password dialog on this desktop, so run these commands once. Libre Hub connects by itself afterwards.';
      actions = [];
    } else if (shown?.outcome === 'failed') {
      title = 'Couldn’t allow access';
      body = shown.error;
      actions = [allowBtn('Try again'), moreBtn];
    }
    root.replaceChildren(el('div', { class: 'empty-box access-box' },
      el('div', { class: 'access-arts' }, el('div', { html: headsetArt('access', { lit: false }) }), el('div', { html: mouseArt('access', { lit: false }) })),
      el('h1', {}, title),
      el('p', {}, body),
      actions.length ? el('div', { class: 'access-actions' }, actions) : null,
      details && shown?.outcome !== 'no-agent' ? explain : null,
      commands ? codeBlock(commands) : null,
      shown?.outcome === 'no-agent' || commands ? el('div', { class: 'status' }, el('span', { class: 'spinner' }), 'Waiting for access') : null));
  };
  listeners.add(() => { if (root.isConnected || busy) paint(); });
  paint();
  return root;
}

/** Settings → Libre Hub: whether access is set up, with Update or Remove. Linux only. */
export function accessSetting() {
  const desc = el('div', { class: 'd' });
  const control = el('div', { class: 'control' });
  const row = el('div', { class: 'setting', hidden: true },
    el('div', {}, el('div', { class: 't' }, 'Device access'), desc), control);
  const after = async (res, done) => {
    if (!res) return;
    if (res.outcome === 'done') toast(done);
    else if (res.outcome === 'cancelled') toast('Nothing was changed.');
    else if (res.outcome === 'no-agent') await commandsDialog('Run these commands', 'There’s no password dialog on this desktop. Run these once in a terminal:');
    else toast(`Couldn’t change device access: ${res.error}`, { kind: 'error', timeout: 8000 });
  };
  const paint = () => {
    row.hidden = !status?.supported;
    if (!status?.supported) return;
    const button = (label, op, primary, done) => el('button', { class: `btn sm${primary ? ' primary' : ' ghost'}`, type: 'button', disabled: !!busy,
      onclick: async () => {
        if (op === 'remove' && !(await confirmDialog({ title: 'Remove device access?',
          body: 'Libre Hub won’t be able to open the A50 X or the G502 X PLUS anymore. It takes effect when you unplug them or restart, and asks for your password.',
          confirm: 'Remove', danger: true }))) return;
        await after(await elevate(op), done);
      } }, busy === op ? [el('span', { class: 'spinner sm' }), 'Waiting…'] : label);
    const pill = (text, cls) => el('span', { class: `pill ${cls}` }, text);
    switch (status.rule) {
      case 'current':
      case 'covered':
        desc.textContent = 'Lets you use the A50 X and G502 X PLUS without running Libre Hub as root.';
        control.replaceChildren(pill('Allowed', 'on'), button('Remove', 'remove', false, 'Access removed. It ends when you unplug the devices or restart.'));
        break;
      case 'outdated':
      case 'partial':
        desc.textContent = `Not set up yet for the ${named(status.missing)}. Updating asks for your password.`;
        control.replaceChildren(pill('Update available', 'warn'), button('Update', 'allow', true, 'Access updated.'));
        break;
      default:
        desc.textContent = 'Libre Hub can’t open your devices until you allow it. This asks for your password once.';
        control.replaceChildren(button('Allow access', 'allow', true, 'Access allowed. Libre Hub can use your devices now.'));
    }
  };
  listeners.add(paint);
  paint();
  return row;
}

void load();
// Someone may have run the commands by hand, or another copy changed it.
window.addEventListener('focus', () => void load());
