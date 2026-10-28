// MX Brio control panel. Like the other devices' panels, pages are built once and then updated in
// place from snapshots. Each change is written to the camera at once (sliders when you let go) and
// kept on this computer, so Libre Hub can put it back when the camera restarts. The preview is the
// camera's own picture, through the browser's getUserMedia; it only runs while you can see it.
import { cameraArt } from './art.js';
import { icon } from './icons.js';
import { appCard } from './prefs.js';
import { confirmDialog, createWriter, dropdown, el, prompt, segmented, slider, toast, toggle } from './ui.js';

const ic = (name, size) => el('span', { style: { display: 'contents' }, html: icon(name, size) });

export const CAMERA_PAGES = [
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'image', label: 'Image', icon: 'palette' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
/** Pages with the preview at the top. */
const PREVIEW_PAGES = new Set(['camera', 'image']);

// G Hub's ranges and steps (src/camera/settings.ts), for the controls.
const SHUTTERS = [2000, 800, 400, 200, 120, 60, 30, 24, 20, 17];
const ISOS = Array.from({ length: 16 }, (_, i) => (i + 1) * 100);
const PAN_STEP = 3600;
const GROUP_TITLES = { crop: 'Framing', exposure: 'Exposure', image: 'Colour', focus: 'Focus' };
const SETTING_LABELS = {
  fov: 'Field of view', zoom: 'Zoom', pan: 'Pan', tilt: 'Tilt', showMode: 'Show Mode', autoExposure: 'Auto exposure', shutter: 'Shutter speed', iso: 'ISO',
  exposureCompensation: 'Exposure compensation', hdr: 'HDR', priority: 'Priority', brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation',
  sharpness: 'Sharpness', tint: 'Tint', vibrance: 'Vibrance', autoWhiteBalance: 'Auto white balance', whiteBalance: 'White balance',
  temperatureCompensation: 'Temperature', autoFocus: 'Auto focus', focus: 'Focus', antiFlicker: 'Anti-flicker',
};

// ------------------------------------------------------------------ preview

const RESOLUTIONS = [
  { id: '360p30', label: '360p · 30', width: 640, height: 360, fps: 30 },
  { id: '720p30', label: '720p · 30', width: 1280, height: 720, fps: 30 },
  { id: '720p60', label: '720p · 60', width: 1280, height: 720, fps: 60 },
  { id: '1080p30', label: '1080p · 30', width: 1920, height: 1080, fps: 30 },
  { id: '1080p60', label: '1080p · 60', width: 1920, height: 1080, fps: 60 },
  { id: '4k30', label: '4K · 30', width: 3840, height: 2160, fps: 30 },
];

/**
 * The live picture, with G Hub's preview options (mirror, grid, resolution, a still). One element,
 * moved into whichever page shows it. `want(on)` starts or stops the camera stream; `mount(page)`
 * puts that page's controls over the picture (`overlay`) and at the end of the bar (`bar`).
 */
function cameraPreview() {
  const prefs = { mirror: false, grid: false, res: '720p30', ...JSON.parse(localStorage.getItem('brioPreview') || '{}') };
  const save = () => localStorage.setItem('brioPreview', JSON.stringify(prefs));
  const video = el('video', { class: 'preview-video', autoplay: true, muted: true, playsinline: true, 'aria-label': 'Camera preview' });
  const grid = el('div', { class: 'preview-grid', 'aria-hidden': 'true' }, ...Array.from({ length: 4 }, () => el('i')));
  const msg = el('div', { class: 'preview-msg', role: 'status' });
  const overlay = el('div', { class: 'preview-overlay' });
  const extras = el('div', { class: 'preview-extras' });
  const frame = el('div', { class: 'preview-frame' }, video, grid, msg, overlay);
  const press = (b, on) => b.setAttribute('aria-pressed', String(on));
  const mirrorBtn = el('button', { type: 'button', class: 'btn ghost sm', title: 'Mirror the preview (only here; apps get the camera’s picture)', onclick: () => { prefs.mirror = !prefs.mirror; save(); paint(); } }, ic('shift', 15), 'Mirror');
  const gridBtn = el('button', { type: 'button', class: 'btn ghost sm', title: 'Rule-of-thirds grid', onclick: () => { prefs.grid = !prefs.grid; save(); paint(); } }, ic('overview', 15), 'Grid');
  const res = dropdown({ label: 'Preview resolution', onChange: (v) => { prefs.res = v; save(); restart(); },
    groups: [{ options: RESOLUTIONS.map((r) => ({ value: r.id, label: r.label, title: `${r.width} × ${r.height}, ${r.fps} frames a second` })) }] });
  const shot = el('button', { type: 'button', class: 'btn ghost sm', title: 'Save a still to Pictures/Webcam Snapshots', onclick: snapshot }, ic('download', 15), 'Snapshot');
  const bar = el('div', { class: 'preview-bar' }, mirrorBtn, gridBtn, res.el, shot, el('span', { class: 'grow' }), extras);
  const root = el('div', { class: 'card preview-card' }, frame, bar);

  let stream = null;
  let wanted = false;
  let starting = null;
  const say = (text) => { msg.textContent = text; msg.hidden = !text; };
  function paint() {
    press(mirrorBtn, prefs.mirror);
    press(gridBtn, prefs.grid);
    video.classList.toggle('mirrored', prefs.mirror);
    grid.hidden = !prefs.grid;
    res.set(prefs.res);
    shot.disabled = !stream;
  }

  async function findCamera() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Labels only show once the page may use the camera: ask with any camera first.
    if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices.find((d) => d.kind === 'videoinput' && /MX Brio/i.test(d.label));
  }

  async function start() {
    if (stream || starting) return starting;
    starting = (async () => {
      say('Starting the preview…');
      try {
        const cam = await findCamera();
        if (!cam) throw new Error('The system lists no MX Brio camera.');
        const r = RESOLUTIONS.find((x) => x.id === prefs.res) ?? RESOLUTIONS[1];
        const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: { ideal: r.width }, height: { ideal: r.height }, frameRate: { ideal: r.fps } } });
        if (!wanted) return void s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        s.getVideoTracks()[0]?.addEventListener('ended', () => { stop(); say('The camera stopped sending pictures.'); });
        say('');
      } catch (err) {
        say(err?.name === 'NotAllowedError' ? 'No permission to use the camera. Allow Libre Hub in your system’s camera privacy settings.'
          : err?.name === 'NotReadableError' ? 'Another app is using the camera, so there’s no preview. Your settings still apply.'
            : `No preview: ${err?.message ?? err}`);
      } finally {
        starting = null;
        paint();
      }
    })();
    return starting;
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    paint();
  }

  async function restart() {
    stop();
    if (wanted) await start();
  }

  async function snapshot() {
    if (!stream || !video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const r = await window.brio.savePhoto(c.toDataURL('image/png'));
    if (r.error) toast(`Couldn’t save the snapshot: ${r.error}`, { kind: 'error', timeout: 7000 });
    else toast(`Saved ${r.file.split(/[\\/]/).pop()} in Pictures/Webcam Snapshots`);
  }

  paint();
  say('Preview paused');
  return {
    el: root,
    mount(page) {
      overlay.replaceChildren(...(page?.overlay ?? []));
      extras.replaceChildren(...(page?.bar ?? []));
    },
    want(on) {
      if (on === wanted) return;
      wanted = on;
      if (on) void start();
      else {
        stop();
        say('Preview paused');
      }
    },
  };
}

// ------------------------------------------------------------------ the controller

export function createCamera({ changed }) {
  let res = null; // last answer from main: { connected, offline?, snapshot?, file? }
  let snap = null;
  let built = null;
  let page = 'camera';
  let active = false;
  const preview = cameraPreview();

  const writer = createWriter((r) => {
    if (r.error && r.connected !== false) toast(friendly(r.error), { kind: 'error', timeout: 7000 });
    if (r.snapshot || r.connected === false) receive(r);
  }, (action) => window.brio.apply(action));
  const send = (key, action, opts) => writer.send(key, action, opts);
  const set = (key, settings) => send(key, { type: 'set', settings });

  function friendly(msg) {
    if (/refused/i.test(msg)) return `The camera didn’t take that: ${msg}`;
    return `Couldn’t apply that: ${msg}`;
  }

  function receive(r) {
    // Answers to writes don't say where settings are saved; keep what the last snapshot said.
    res = r.snapshot || !r.connected ? { ...r, file: r.file ?? res?.file } : { ...r, snapshot: snap, file: res?.file };
    if (r.connected && r.snapshot) {
      snap = r.snapshot;
      if (!built || built.serial !== snap.device.serial) built = build(snap.device.serial);
      for (const p of Object.values(built.pages)) p.update(snap);
    } else if (!r.connected) {
      snap = null;
      writer.reset();
    }
    changed('card');
    changed('nav');
    changed('main');
    syncPreview();
  }

  let inflight = false;
  let again = false;
  async function refresh() {
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      receive(await window.brio.snapshot().catch((err) => ({ connected: true, error: String(err?.message ?? err) })));
    } finally {
      inflight = false;
      if (again) { again = false; void refresh(); }
    }
  }

  // The preview runs only while it's on screen: this device, a page with it, the window in front.
  function syncPreview() {
    const on = active && !!snap && PREVIEW_PAGES.has(page) && !document.hidden && document.hasFocus();
    const slot = built?.pages[page]?.slot;
    if (slot && preview.el.parentNode !== slot) {
      slot.append(preview.el);
      preview.mount(built.pages[page]);
    }
    preview.want(on);
  }
  for (const ev of ['focus', 'blur']) window.addEventListener(ev, syncPreview);
  document.addEventListener('visibilitychange', syncPreview);

  let pending;
  window.brio.onChanged((what) => {
    if (what === 'restored') toast('Put your camera settings back (the camera had restarted)');
    clearTimeout(pending);
    pending = setTimeout(refresh, what === 'connected' ? 300 : 150);
  });
  // While offline, re-check now and then so the guidance follows what the user does.
  setInterval(() => { if (!snap) void refresh(); }, 3000);
  // Other programs (G Hub, a video call app) can change settings too: re-read while showing.
  setInterval(() => { if (snap && active && writer.idle && !document.hidden && document.hasFocus()) void refresh(); }, 5000);

  const ctx = {
    send, set, quiet: (key) => writer.quiet(key), receive: (r) => receive(r), go: (id) => show(id, { focus: true }),
    get snap() { return snap; }, get file() { return res?.file; },
  };

  function build(serial) {
    return { serial, pages: { camera: cameraPage(ctx), image: imagePage(ctx), settings: settingsPage(ctx) } };
  }

  function show(id, { focus = false } = {}) {
    page = id;
    changed('nav');
    changed('main');
    syncPreview();
    if (focus) built?.pages[id]?.el.querySelector('h1')?.focus({ preventScroll: true });
  }

  function offlineNode() {
    const off = res?.offline ?? (res?.connected && res.error ? { reason: 'error', error: `Couldn’t read the camera: ${res.error}` } : { reason: res ? 'not-found' : 'connecting' });
    const box = (title, body, ...extra) =>
      el('div', { class: 'empty' }, el('div', { class: 'empty-box' },
        el('div', { html: cameraArt('empty', { lit: false }) }),
        el('h1', {}, title), el('p', {}, body), ...extra));
    const waiting = (t) => el('div', { class: 'status' }, el('span', { class: 'spinner' }), t);
    switch (off.reason) {
      case 'connecting':
        return el('div', { class: 'empty' }, el('div', { class: 'empty-box' }, waiting('Connecting…')));
      case 'restarting':
        return box('The camera is restarting', 'It restarts to switch its microphones on or off, which takes a few seconds. Your framing is put back when it’s here again.', waiting('Waiting for the camera'));
      case 'permission':
        return box('Allow access to the camera', window.a50x.platform === 'linux'
          ? 'Your user can’t open the camera’s video device. Log in at the computer (not over SSH), or add yourself to the “video” group and log in again.'
          : off.error, waiting('Waiting for access'));
      case 'error':
        return box('Couldn’t connect', off.error ?? 'Something went wrong talking to the camera.', waiting('Trying again'));
      default:
        return box('Connect your MX Brio', 'Plug it into this computer with its USB-C cable.', waiting('Looking for the camera'));
    }
  }

  let offline = null;
  let offlineKey = '';
  function node() {
    if (snap && built) return built.pages[page].el;
    const key = `${res?.offline?.reason}|${res?.offline?.error ?? res?.error ?? ''}|${!!res}`;
    if (key !== offlineKey || !offline) {
      offlineKey = key;
      offline = offlineNode();
    }
    return offline;
  }

  void refresh();

  return {
    pages: CAMERA_PAGES,
    get page() { return page; },
    get online() { return !!snap; },
    get asleep() { return false; },
    card() {
      const restarting = res?.offline?.reason === 'restarting';
      const status = snap ? 'Connected' : !res ? 'Connecting…'
        : restarting ? 'Restarting…' : { 'not-found': 'Searching…', permission: 'No access', error: 'Not connected' }[res.offline?.reason ?? (res.error ? 'error' : '')] ?? 'Not connected';
      return {
        name: 'MX Brio',
        status,
        dot: snap ? 'on' : 'wait',
        battery: null,
        art: cameraArt('thumb', { glow: false, lit: !!snap, small: true }),
      };
    },
    hints() {
      if (!snap) return {};
      const s = snap.settings;
      return {
        camera: [`${s.fov}°${s.zoom > 100 ? ` · ${(s.zoom / 100).toFixed(1)}×` : ''}`, 'Field of view and zoom'],
        image: [presetName(snap, 'image') ?? 'Custom', 'Colour preset'],
      };
    },
    firmware() {
      return snap ? `Firmware ${snap.device.firmware}` : null;
    },
    node,
    show,
    setActive(on) {
      active = on;
      if (on) void refresh();
      syncPreview();
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

const setting = (title, desc, control) =>
  el('div', { class: 'setting compact' },
    el('div', {}, el('div', { class: 't' }, title), desc ? el('div', { class: 'd' }, desc) : null),
    el('div', { class: 'control' }, control));

const presetName = (s, group) => s.presets.find((p) => p.group === group && p.matches)?.name;

/** A slider row for one setting: label, slider, value. Writes when you let go. */
function rangeRow(ctx, key, { label, min, max, step = 1, format = String, toValue = (v) => v, fromValue = (v) => v }) {
  const val = el('span', { class: 'val' });
  const s = slider({ min, max, step, label, quiet: () => ctx.quiet(key), valueText: (v) => format(toValue(v)),
    onPreview: (v) => { val.textContent = format(toValue(v)); },
    onCommit: (v) => ctx.set(key, { [key]: toValue(v) }) });
  const row = el('div', { class: 'param' }, el('span', { class: 'param-k' }, label), s.el, val);
  return {
    el: row,
    update(snap, disabled = false) {
      s.set(fromValue(snap.settings[key]));
      s.el.disabled = disabled;
      row.classList.toggle('off', disabled);
    },
  };
}

/** A switch row: title, description, toggle. */
function switchRow(ctx, key, title, desc) {
  const t = toggle({ label: title, onChange: (on) => ctx.set(key, { [key]: on }) });
  return { el: setting(title, desc, t.el), update(snap) { if (!ctx.quiet(key)) t.set(snap.settings[key]); } };
}

/**
 * G Hub's per-tab preset menu: its presets and yours, "Custom" when the settings match none, a way
 * to save the current settings as a preset and to delete yours, and Reset to default.
 */
/** Save (the current settings as a preset of yours) and Delete (`current()`, one of yours), for a card's presets. */
function presetActions(ctx, group, current) {
  const del = el('button', { type: 'button', class: 'btn ghost sm', title: 'Delete this preset', hidden: true }, ic('trash', 14));
  const saveBtn = el('button', { type: 'button', class: 'btn ghost sm', title: 'Save these settings as a preset' }, ic('save', 14), 'Save');
  saveBtn.addEventListener('click', async () => {
    const name = await prompt({ title: `Save ${GROUP_TITLES[group].toLowerCase()} preset`, body: 'Saved on this computer, with the camera’s current settings for this card.', label: 'Preset name', confirm: 'Save', maxlength: 32 });
    if (!name) return;
    const r = await ctx.send(`preset:${group}`, { type: 'savePreset', group, name }, { coalesce: false });
    if (r.connected && !r.error) toast(`Saved “${name}”`);
  });
  del.addEventListener('click', async () => {
    const name = current();
    if (!(await confirmDialog({ title: `Delete “${name}”?`, body: 'The preset is removed from this computer. The camera keeps its current settings.', confirm: 'Delete', danger: true }))) return;
    ctx.send(`preset:${group}`, { type: 'deletePreset', group, name }, { coalesce: false });
  });
  return { del, saveBtn };
}

function presetPicker(ctx, group) {
  const select = dropdown({ label: `${GROUP_TITLES[group]} preset`, placeholder: 'Custom',
    onChange: (name) => ctx.send(`preset:${group}`, { type: 'preset', group, name }, { coalesce: false }) });
  const { del, saveBtn } = presetActions(ctx, group, () => select.value);
  const reset = el('button', { type: 'button', class: 'btn ghost sm', title: 'G Hub’s defaults for this card' }, ic('reset', 14), 'Reset');
  reset.addEventListener('click', () => ctx.send(`preset:${group}`, { type: 'reset', group }, { coalesce: false }));
  let sig = '';
  return {
    el: el('div', { class: 'preset-picker' }, select.el, del, saveBtn, reset),
    update(snap) {
      const list = snap.presets.filter((p) => p.group === group);
      const match = list.find((p) => p.matches);
      const next = JSON.stringify([list.map((p) => [p.name, p.curated]), match?.name]);
      if (next !== sig) {
        sig = next;
        const options = (curated) => list.filter((p) => p.curated === curated).map((p) => ({ value: p.name, label: p.name }));
        select.setGroups([{ label: 'G Hub presets', options: options(true) },
          ...(list.some((p) => !p.curated) ? [{ label: 'Your presets', options: options(false) }] : [])]);
        // Settings that match no preset show as Custom.
        select.set(match?.name ?? null);
        del.hidden = !match || match.curated;
      }
    },
  };
}

/** G Hub's framing presets by what they do, in this order; its names are kept as their tooltips. */
const FRAMING_LABELS = { 'FOV 65°': '65° Close', 'FOV 78°': '78° Medium', Default: '90° Wide', 'Zoom 1.5×': '1.5×', 'Zoom 2×': '2×' };
const FRAMING_TITLES = {
  'FOV 65°': 'Head and shoulders', 'FOV 78°': 'Upper body', Default: 'The whole desk: G Hub’s default framing', 'Zoom 1.5×': 'Wide, zoomed in 1.5×', 'Zoom 2×': 'Wide, zoomed in 2×',
};

/**
 * The framing presets as one row of choices: G Hub's, then yours. Each sets the whole framing (field of
 * view, zoom, pan, tilt, Show Mode), as in G Hub, so 78° Medium also takes the zoom back to 1×. The one
 * the camera matches is lit; none is when you've changed something since. The arrow keys move along it.
 */
function framingPresets(ctx) {
  const row = el('div', { class: 'segmented preset-strip', role: 'radiogroup', 'aria-label': 'Framing presets' });
  let lit = null;
  const { del, saveBtn } = presetActions(ctx, 'crop', () => lit);
  const buttons = () => [...row.querySelectorAll('button')];
  function light(name) {
    lit = name;
    for (const b of buttons()) {
      b.setAttribute('aria-checked', String(b.dataset.name === name));
      b.tabIndex = b.dataset.name === name ? 0 : -1;
    }
    const first = buttons()[0];
    if (name === null && first) first.tabIndex = 0;
  }
  function pick(name) {
    light(name);
    ctx.send('preset:crop', { type: 'preset', group: 'crop', name }, { coalesce: false });
  }
  row.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const all = buttons();
    const next = all[(all.indexOf(document.activeElement) + dir + all.length) % all.length];
    next.focus();
    pick(next.dataset.name);
  });
  let sig = '';
  return {
    el: row,
    actions: [saveBtn, del],
    update(snap) {
      const list = snap.presets.filter((p) => p.group === 'crop');
      const order = Object.keys(FRAMING_LABELS);
      const rank = (p) => (p.curated ? (order.indexOf(p.name) + 1 || order.length + 1) : order.length + 2);
      const next = JSON.stringify(list.map((p) => [p.name, p.curated]));
      if (next !== sig) {
        sig = next;
        const sorted = [...list].sort((a, b) => rank(a) - rank(b));
        row.replaceChildren(...sorted.flatMap((p, i) => [
          // a line between G Hub's and yours
          i > 0 && !p.curated && sorted[i - 1].curated ? el('span', { class: 'stage-sep', 'aria-hidden': 'true' }) : null,
          el('button', { type: 'button', role: 'radio', 'data-name': p.name, tabindex: '-1', onclick: () => pick(p.name),
            title: p.curated ? `${FRAMING_TITLES[p.name] ?? p.name} (G Hub’s “${p.name}”)` : 'Your preset' }, p.curated ? FRAMING_LABELS[p.name] ?? p.name : p.name),
        ].filter(Boolean)));
      }
      const match = list.find((p) => p.matches);
      if (!ctx.quiet('preset:crop')) light(match?.name ?? null);
      del.hidden = !match || match.curated;
    },
  };
}

// ---------------------------------------------------------------- camera (framing)

function cameraPage(ctx) {
  const slot = el('div', { class: 'preview-slot' });
  const presets = framingPresets(ctx);
  const zoom = rangeRow(ctx, 'zoom', { label: 'Zoom', min: 100, max: 400, format: (v) => `${(v / 100).toFixed(v % 100 ? 2 : 1)}×` });
  const map = cropMap(ctx);
  const showDesc = 'Tilt the camera down at your desk and it turns the picture the right way up, to share notes and sketches.';
  const show = toggle({ label: 'Show Mode', onChange: (on) => ctx.set('showMode', { showMode: on }) });
  show.el.title = showDesc;

  // The picture is the page: framing floats over it on glass, the way a camera app has it.
  const node = pageShell('Camera', 'What the camera shows: how wide, how close, and where. Apps get the camera with these settings.',
    el('div', { class: 'camera-stage' }, slot));

  return {
    el: node,
    slot,
    overlay: [el('div', { class: 'stage-controls' }, presets.el, el('span', { class: 'stage-sep' }), zoom.el), map.el],
    bar: [
      el('div', { class: 'stage-item', title: showDesc }, el('span', { class: 'k' }, 'Show Mode'), show.el),
      el('span', { class: 'stage-sep' }),
      el('div', { class: 'stage-item' }, el('span', { class: 'k' }, 'Framing'), ...presets.actions),
    ],
    update(s) {
      presets.update(s);
      zoom.update(s);
      map.update(s);
      if (!ctx.quiet('showMode')) show.set(s.settings.showMode);
    },
  };
}

/**
 * Where the zoomed-in picture sits in the camera's whole view, as a box on a small map: drag it, or
 * use the arrow keys, to pan and tilt. Pan and tilt only do anything zoomed in, so it shows then.
 * The box's travel is pan and tilt's ±20° spread over the room the zoom leaves (an approximation:
 * it shows which way and how far, not the exact crop). Writes when you let go, like the sliders.
 */
function cropMap(ctx) {
  const LIMIT = 20;
  const box = el('i');
  const map = el('div', { class: 'crop-map', role: 'slider', tabindex: '0', 'aria-label': 'Pan and tilt',
    'aria-valuemin': String(-LIMIT), 'aria-valuemax': String(LIMIT), title: 'Drag to pan and tilt' }, box);
  const root = el('div', { class: 'crop-wrap' }, map, el('span', { class: 'crop-cap' }, 'Drag to pan and tilt'));
  let zoom = 100, pan = 0, tilt = 0; // degrees
  let held = false;
  let timer = 0;
  const deg = (v) => `${v > 0 ? '+' : ''}${v}°`;
  const room = () => 1 - 100 / zoom;
  // The mirrored preview flips the map with it, so the box moves the way the picture does.
  const flip = () => (map.closest('.preview-frame')?.querySelector('.preview-video.mirrored') ? -1 : 1);

  function paint() {
    map.style.setProperty('--w', `${(100 / zoom) * 100}%`);
    map.style.setProperty('--x', `${50 + (pan / LIMIT) * room() * 50}%`);
    map.style.setProperty('--y', `${50 - (tilt / LIMIT) * room() * 50}%`);
    map.setAttribute('aria-valuenow', String(pan));
    map.setAttribute('aria-valuetext', `Pan ${deg(pan)}, tilt ${deg(tilt)}`);
  }
  const clamp = (v) => Math.max(-LIMIT, Math.min(LIMIT, Math.round(v)));
  const commit = () => { clearTimeout(timer); timer = 0; ctx.set('pantilt', { pan: pan * PAN_STEP, tilt: tilt * PAN_STEP }); };

  function moveTo(e) {
    const r = map.getBoundingClientRect();
    const half = room() / 2;
    if (!half) return;
    pan = clamp((((e.clientX - r.left) / r.width - 0.5) / half) * LIMIT * flip());
    tilt = clamp((-((e.clientY - r.top) / r.height - 0.5) / half) * LIMIT);
    paint();
  }
  map.addEventListener('pointerdown', (e) => {
    held = true;
    map.setPointerCapture(e.pointerId);
    moveTo(e);
  });
  map.addEventListener('pointermove', (e) => { if (held) moveTo(e); });
  for (const ev of ['pointerup', 'pointercancel']) map.addEventListener(ev, () => { if (held) { held = false; commit(); } });
  map.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!step) return;
    e.preventDefault();
    pan = clamp(pan + step[0] * flip());
    tilt = clamp(tilt + step[1]);
    paint();
    // From the keyboard each press is a change; send once the keys pause.
    clearTimeout(timer);
    timer = setTimeout(commit, 450);
  });
  map.addEventListener('blur', () => { if (timer) commit(); });

  return {
    el: root,
    update(snap) {
      zoom = snap.settings.zoom;
      root.hidden = zoom <= 100;
      if (!held && !timer && !ctx.quiet('pantilt')) {
        pan = snap.settings.pan / PAN_STEP;
        tilt = snap.settings.tilt / PAN_STEP;
      }
      paint();
    },
  };
}

// ---------------------------------------------------------------- image (exposure, colour, focus)

function imagePage(ctx) {
  const slot = el('div', { class: 'preview-slot' });

  // Exposure
  const exPresets = presetPicker(ctx, 'exposure');
  const autoEx = switchRow(ctx, 'autoExposure', 'Auto exposure', 'The camera picks shutter speed and ISO for the light.');
  const shutter = rangeRow(ctx, 'shutter', { label: 'Shutter speed', min: 0, max: SHUTTERS.length - 1, format: (v) => `1/${v}`, toValue: (i) => SHUTTERS[i], fromValue: (v) => Math.max(0, SHUTTERS.indexOf(v)) });
  const iso = rangeRow(ctx, 'iso', { label: 'ISO', min: 0, max: ISOS.length - 1, format: (v) => String(v), toValue: (i) => ISOS[i], fromValue: (v) => Math.max(0, ISOS.indexOf(v)) });
  const comp = rangeRow(ctx, 'exposureCompensation', { label: 'Compensation', min: 0, max: 255, format: (v) => (v === 128 ? '0' : `${v > 128 ? '+' : ''}${v - 128}`) });
  const hdr = switchRow(ctx, 'hdr', 'HDR', 'Keeps bright windows and dark corners visible at the same time.');
  const priority = segmented({ label: 'Priority', options: [{ value: 'exposure', label: 'Exposure' }, { value: 'frame-rate', label: 'Frame rate' }],
    onChange: (v) => ctx.set('priority', { priority: v }) });

  // Colour
  const imPresets = presetPicker(ctx, 'image');
  const colourRows = [
    rangeRow(ctx, 'brightness', { label: 'Brightness', min: 0, max: 255 }),
    rangeRow(ctx, 'contrast', { label: 'Contrast', min: 0, max: 255 }),
    rangeRow(ctx, 'saturation', { label: 'Saturation', min: 0, max: 255 }),
    rangeRow(ctx, 'vibrance', { label: 'Vibrance', min: 0, max: 255 }),
    rangeRow(ctx, 'sharpness', { label: 'Sharpness', min: 0, max: 255 }),
    rangeRow(ctx, 'tint', { label: 'Tint', min: 0, max: 100, format: (v) => (v === 50 ? '0' : `${v > 50 ? '+' : ''}${v - 50}`) }),
  ];
  const autoWb = switchRow(ctx, 'autoWhiteBalance', 'Auto white balance', 'The camera matches the colour of your light.');
  const wb = rangeRow(ctx, 'whiteBalance', { label: 'White balance', min: 2800, max: 7500, step: 100, format: (v) => `${v} K` });
  const temp = rangeRow(ctx, 'temperatureCompensation', { label: 'Temperature', min: 0, max: 100, format: (v) => (v === 50 ? '0' : v > 50 ? `+${v - 50} warmer` : `${v - 50} cooler`) });

  // Focus
  const foPresets = presetPicker(ctx, 'focus');
  const autoFo = switchRow(ctx, 'autoFocus', 'Auto focus', 'Keeps whatever is in the middle of the picture sharp.');
  const focus = rangeRow(ctx, 'focus', { label: 'Focus', min: 0, max: 255, format: (v) => (v < 30 ? `${v} (far)` : v > 200 ? `${v} (near)` : String(v)) });

  const node = pageShell('Image', 'How the picture looks: exposure, colour and focus. Like G Hub, Libre Hub writes these to the camera, so every app gets them.',
    el('div', { class: 'camera-layout' },
      slot,
      el('div', { class: 'stack' }, el('div', { class: 'card' },
        cardHead('sun', 'Exposure', null, exPresets.el),
        autoEx.el,
        el('div', { class: 'params' }, shutter.el, iso.el, comp.el),
        hdr.el,
        setting('Priority', 'In low light, keep the frame rate (darker picture) or the exposure (fewer frames a second).', priority.el)),
      el('div', { class: 'card' },
        cardHead('palette', 'Colour', null, imPresets.el),
        el('div', { class: 'params' }, ...colourRows.map((r) => r.el)),
        autoWb.el,
        el('div', { class: 'params' }, wb.el, temp.el)),
      el('div', { class: 'card' },
        cardHead('crosshair', 'Focus', null, foPresets.el),
        autoFo.el,
        el('div', { class: 'params' }, focus.el)))));

  return {
    el: node,
    slot,
    update(s) {
      const st = s.settings;
      exPresets.update(s);
      autoEx.update(s);
      shutter.update(s, st.autoExposure);
      iso.update(s, st.autoExposure);
      comp.update(s);
      hdr.update(s);
      if (!ctx.quiet('priority')) priority.set(st.priority);
      imPresets.update(s);
      for (const r of colourRows) r.update(s);
      autoWb.update(s);
      wb.update(s, st.autoWhiteBalance);
      temp.update(s);
      foPresets.update(s);
      autoFo.update(s);
      focus.update(s, st.autoFocus);
    },
  };
}

// ---------------------------------------------------------------- settings

function settingsPage(ctx) {
  const mic = toggle({ label: 'Microphones', onChange: async (on) => {
    const yes = await confirmDialog({ title: `Turn the microphones ${on ? 'on' : 'off'}?`,
      body: `The camera restarts to apply this, so it disappears for a few seconds and any app using it loses the picture. ${on ? 'Its microphones then show up as a sound input.' : 'It then has no sound input at all.'}`,
      confirm: on ? 'Turn on and restart' : 'Turn off and restart' });
    if (!yes) return void mic.set(!on);
    ctx.send('mic', { type: 'microphone', enabled: on }, { coalesce: false });
  } });
  const flicker = segmented({ label: 'Anti-flicker', options: [{ value: 50, label: '50 Hz' }, { value: 60, label: '60 Hz' }], onChange: (v) => ctx.set('antiFlicker', { antiFlicker: v }) });
  const kept = el('div', { class: 'kept' });
  const forget = el('button', { type: 'button', class: 'btn sm', onclick: async () => {
    if (!(await confirmDialog({ title: 'Stop putting settings back?', body: 'Libre Hub forgets the settings it keeps for this camera. The camera keeps what it has now, until it restarts.', confirm: 'Forget them' }))) return;
    ctx.send('forget', { type: 'forget' }, { coalesce: false });
  } }, 'Forget');
  const resetAll = el('button', { type: 'button', class: 'btn sm', onclick: async () => {
    if (!(await confirmDialog({ title: 'Reset every camera setting?', body: 'Framing, exposure, colour, focus and anti-flicker go back to G Hub’s defaults. Your presets stay.', confirm: 'Reset all', danger: true }))) return;
    ctx.send('reset', { type: 'reset', group: 'all' }, { coalesce: false });
  } }, ic('reset', 14), 'Reset all');
  const facts = el('div', { class: 'facts' });

  const node = pageShell('Settings', 'The camera’s microphones and mains frequency, and what Libre Hub keeps for it.',
    el('div', { class: 'stack' },
      el('div', { class: 'card' },
        cardHead('camera', 'Camera', null),
        setting('Microphones', 'The camera’s two microphones. Turning them on or off restarts the camera; it remembers the choice.', mic.el),
        setting('Anti-flicker', 'Match your mains frequency so lights don’t flicker in the picture: 50 Hz in most of Europe, Asia, Africa and Australia, 60 Hz in the Americas.', flicker.el)),
      el('div', { class: 'card' },
        cardHead('save', 'Keeping your settings', 'The camera forgets its framing and exposure mode when it restarts, and another program can change any of it. Like G Hub, Libre Hub puts your settings back whenever the camera connects, while it runs.'),
        kept,
        el('div', { class: 'audio-foot' }, el('span', { class: 'kept-file' }), el('div', { class: 'actions' }, resetAll, forget))),
      appCard(),
      el('div', { class: 'card' }, cardHead('info', 'About this camera', null), facts)));

  return {
    el: node,
    update(s) {
      if (!ctx.quiet('mic')) mic.set(s.microphone);
      if (!ctx.quiet('antiFlicker')) flicker.set(s.settings.antiFlicker);
      const keys = Object.keys(s.saved);
      kept.replaceChildren(el('p', { class: 'audio-text' }, keys.length
        ? `Put back on connect: ${keys.map((k) => SETTING_LABELS[k] ?? k).join(', ')}.`
        : 'Nothing yet. Settings you change here are kept.'));
      forget.disabled = !keys.length;
      node.querySelector('.kept-file').replaceChildren('Saved in ', el('code', {}, (ctx.file ?? '').replace(/^\/(Users|home)\/[^/]+/, '~')));
      const d = s.device;
      const rows = [
        ['Model', d.model],
        ['Firmware', d.firmware, 'mono'],
        ['Serial number', d.serial, 'mono'],
        ['Microphones', s.microphone ? 'On' : 'Off'],
      ];
      facts.replaceChildren(...rows.map(([k, v, cls = '']) =>
        el('div', { class: 'fact' }, el('span', { class: 'k' }, k), el('span', { class: `v ${cls}`, title: v }, v))));
    },
  };
}
