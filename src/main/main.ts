// Electron main process: owns the device connection and exposes it to the window over IPC.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LevelMeters } from '../audio/meters.js';
import { AudioSplit, runCommand } from '../audio/split.js';
import { A50X, TimeoutError } from '../device/a50x.js';
import { findA50X, openA50X } from '../device/transport.js';
import { PresetStore } from '../presets/store.js';
import { SettingsKeeper } from '../restore/keeper.js';
import { ALL_GROUPS, GROUPS, type Group } from '../restore/settings.js';
import { RestoreStore, type HistoryEntry, type Trigger } from '../restore/store.js';
import { A50XService, type Action, type Snapshot } from '../service.js';
import { APP_ID, APP_NAME, Autostart } from './autostart.js';
import { loadPrefs, savePrefs, type Prefs } from './prefs.js';
import { watchLinuxUnlock } from './session.js';
import { Updates, type UpdateState } from './updates.js';
import { registerMouse } from './mouse-ipc.js';
import { DeviceAccess, RULE_FILE } from '../access/udev.js';

const here = dirname(fileURLToPath(import.meta.url));
// The app is called Libre Hub, but its files stay where they've always been (the CLI reads them too).
app.setPath('userData', join(app.getPath('appData'), 'logitech-manager'));
app.setName(APP_NAME);
const iconPath = join(here, '..', 'renderer', 'assets', 'icon.png');
/** The udev rule and WirePlumber files. Packaged, they sit unpacked next to app.asar so tools like `sudo cp` can read them. */
const linuxFiles = () => join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'linux');
/** The LH mark without the wordmark, which is unreadable at panel sizes. */
const trayIconPath = join(here, '..', 'renderer', 'assets', 'tray.png');
const EVENTS = ['sidetone', 'volume', 'balance', 'sleep', 'tones', 'noiseGate', 'routing', 'equalizer', 'battery', 'settingsChecksum'];

/** Why there is no device, so the window can say what to do about it. */
type Offline =
  | { reason: 'not-found' }
  | { reason: 'permission'; error: string }
  | { reason: 'unresponsive'; error: string }
  | { reason: 'error'; error: string };

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let lastSnapshot: Snapshot | undefined;
let service: A50XService | undefined;
let connecting: Promise<A50XService | undefined> | undefined;
let offline: Offline = { reason: 'not-found' };
/** After the headset stops answering, wait a bit before reopening the device again. */
let retryAt = 0;

function classify(err: unknown): Offline {
  const error = (err as Error)?.message ?? String(err);
  if (/permission denied|EACCES|cannot open device/i.test(error)) {
    return { reason: 'permission', error };
  }
  if (err instanceof TimeoutError) return { reason: 'unresponsive', error };
  return { reason: 'error', error };
}

/** Errors that mean the link to the device is gone (as opposed to e.g. a rejected setting). */
const isLinkError = (err: unknown) =>
  err instanceof TimeoutError || /device closed|could not (read|write)|cannot (read|write)|disconnected/i.test((err as Error)?.message ?? '');

function lose(err: unknown): { connected: false; offline: Offline } {
  offline = classify(err);
  if (offline.reason === 'unresponsive') retryAt = Date.now() + 5000;
  disconnect();
  return { connected: false, offline };
}
const mouse = registerMouse(ipcMain, () => window, { onStatus: () => refreshTray() });

// Linux: let this user open the devices, after asking for the password once (see src/access/udev.ts).
const access = new DeviceAccess({ shippedRule: join(linuxFiles(), RULE_FILE) });
ipcMain.handle('access:status', () => access.status());
ipcMain.handle('access:manual', () => access.manual());
ipcMain.handle('access:remove', () => access.remove());
ipcMain.handle('access:allow', async () => {
  const result = await access.allow();
  if (result.outcome === 'done') {
    // Connect now rather than at the next poll.
    retryAt = 0;
    void connect();
    mouse.retry();
  }
  return result;
});

async function connect(): Promise<A50XService | undefined> {
  if (service) return service;
  if (Date.now() < retryAt) return undefined;
  // Cleared once settled, not in a `finally` inside: when the body fails before its first await,
  // that would run before the assignment and leave this settled promise in place for good.
  connecting ??= (async () => {
    try {
      if (!findA50X()) {
        offline = { reason: 'not-found' };
        return undefined;
      }
      const transport = openA50X();
      const device = await A50X.connect(transport);
      transport.onError(() => disconnect());
      for (const ev of EVENTS) device.on(ev, () => window?.webContents.send('a50x:changed', ev));
      // The volume wheel is on the headset, so its changes are kept as they happen.
      device.on('volume', (v: { level: number; muted: boolean }) => void keeper.observe({ volume: { level: v.level, muted: v.muted } }));
      service = new A50XService(device, new PresetStore(join(app.getPath('userData'), 'presets.json')));
      window?.webContents.send('a50x:changed', 'connected');
      // A headset that just came back (powered on, plugged in, woke up) may have lost its settings.
      keeper.request('reconnect', 1500);
      refreshTray();
      return service;
    } catch (err) {
      const next = classify(err);
      if (next.reason !== offline.reason) console.error('connect failed:', (err as Error).message);
      offline = next;
      if (next.reason === 'unresponsive') retryAt = Date.now() + 5000;
      return undefined;
    }
  })().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

/** Keep the newest snapshot for the tray (battery, name). */
function seen(snapshot: Snapshot): Snapshot {
  const battery = lastSnapshot?.battery;
  lastSnapshot = snapshot;
  if (battery !== snapshot.battery) refreshTray();
  return snapshot;
}

function disconnect(): void {
  try {
    service?.device.close();
  } catch {
    // already gone
  }
  service = undefined;
  lastSnapshot = undefined;
  window?.webContents.send('a50x:changed', 'disconnected');
  refreshTray();
}

ipcMain.handle('a50x:snapshot', async () => {
  if (shuttingDown) return { connected: false, offline };
  const svc = await connect();
  if (!svc) return { connected: false, offline };
  try {
    return { connected: true, snapshot: seen(await svc.snapshot()) };
  } catch (err) {
    if (isLinkError(err)) return lose(err);
    // Not a dead link (e.g. an unexpected reply): report it without tearing the connection down.
    return { connected: false, offline: classify(err) };
  }
});

ipcMain.handle('a50x:apply', async (_e, action: Action) => {
  const svc = await connect();
  if (!svc) return { connected: false, offline };
  try {
    await svc.apply(action);
  } catch (err) {
    if (isLinkError(err)) return lose(err);
    return { connected: true, error: (err as Error).message, snapshot: await svc.snapshot().catch(() => undefined) };
  }
  // The change went through; a failed read afterwards isn't a failed change.
  try {
    const snapshot = seen(await svc.snapshot());
    void keeper.record(action, snapshot).catch((err) => console.error('could not save the setting:', (err as Error).message));
    return { connected: true, snapshot };
  } catch (err) {
    return isLinkError(err) ? lose(err) : { connected: true };
  }
});

// Linux: split the base station's audio into Game and Voice outputs (see src/audio/split.ts).
const audio = process.platform === 'linux' ? new AudioSplit({ run: runCommand, assetsDir: join(linuxFiles(), 'wireplumber') }) : undefined;
const audioCall = async (op: 'status' | 'setup' | 'undo') => {
  if (!audio) return { status: null };
  try {
    return { status: await audio[op]() };
  } catch (err) {
    return { error: (err as Error).message, status: await audio.status().catch(() => null) };
  }
};
ipcMain.handle('audio:status', () => audioCall('status'));
ipcMain.handle('audio:setup', () => audioCall('setup'));
ipcMain.handle('audio:undo', () => audioCall('undo'));

// Live levels for the Stream Mix and Microphone pages, read from the split's devices (see src/audio/meters.ts).
// The window asks for the meters of the page it shows, and for none when it's hidden or unfocused.
const meters = audio
  ? new LevelMeters({
    nodes: async () => {
      const status = await audio.status();
      return status.active ? status.nodes : null;
    },
    onFrame: (frame) => { if (!window?.isDestroyed()) window?.webContents.send('meters:levels', frame); },
    onLost: (key) => { if (!window?.isDestroyed()) window?.webContents.send('meters:lost', key); },
  })
  : undefined;
ipcMain.handle('meters:watch', (_e, keys: unknown) =>
  meters && Array.isArray(keys) ? meters.watch(keys) : { running: [] });

const t0 = Date.now();
const trace = (what: string) => console.log(`[${Date.now() - t0}ms] ${what}`);
for (const ev of ['before-quit', 'will-quit', 'quit'] as const) app.on(ev as 'quit', () => trace(ev));

// One copy at a time: two would fight over the base station. Launching it again opens the window.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
app.on('second-instance', () => showWindow());

// ------------------------------------------------------------------ preferences and kept settings

const userFile = (name: string) => join(app.getPath('userData'), name);
let prefs: Prefs = loadPrefs(userFile('preferences.json'));
const setPrefs = (next: Prefs) => {
  prefs = next;
  savePrefs(userFile('preferences.json'), prefs);
};

const store = new RestoreStore(userFile('restore.json'));
const keeper = new SettingsKeeper({
  store,
  service: connect,
  config: () => ({ enabled: prefs.keepSettings, groups: ALL_GROUPS }),
  isLinkError,
  onLinkError: (err) => void lose(err),
  onCheck: (entry) => reportCheck(entry),
});
let lastCheck: HistoryEntry | undefined;
let stopUnlock: (() => void) | undefined;

// Started at login: stay in the tray until asked for.
const startHidden = process.argv.includes('--hidden');
// An AppImage runs from a temporary mount, so start the image itself, but only if this app is
// that image: APPIMAGE is inherited by anything launched from another AppImage app's terminal.
const { APPIMAGE, APPDIR } = process.env;
const appImage = app.isPackaged && APPIMAGE && APPDIR && process.execPath.startsWith(APPDIR) ? APPIMAGE : undefined;

// Updates come from GitHub Releases, and only an AppImage can replace itself.
let notifiedUpdate = '';
const updates = new Updates({
  enabled: !!appImage,
  feedUrl: process.env.LIBRE_HUB_UPDATE_URL,
  onChange: (state: UpdateState) => {
    window?.webContents.send('app:event', 'update', state);
    refreshTray();
    if (state.status === 'ready' && notifiedUpdate !== state.version) {
      notifiedUpdate = state.version;
      notify(`${APP_NAME} ${state.version} is ready`, 'It’s installed when you quit. To update now, use Restart to update in the tray menu or in Settings.', () => showWindow({ settings: true }));
    }
  },
});

const autostart = new Autostart(
  { command: appImage ?? process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] },
  // Linux entries name the icon installed into the icon theme; a LaunchAgent has none.
  { platform: process.platform, home: homedir(), env: process.env, icon: APP_ID },
);

const WHEN: Record<Trigger, string> = {
  startup: 'when the app started',
  wake: 'while the computer was asleep',
  unlock: 'while the computer was locked',
  reconnect: 'while the headset was disconnected',
  manual: '',
  'follow-up': 'shortly after the last check',
};
const lower = (g: Group) => {
  const label = GROUPS.find((x) => x.id === g)?.label ?? g;
  return label.charAt(0).toLowerCase() + label.slice(1);
};
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

let notice: Notification | undefined; // kept so its click handler isn't collected
function notify(title: string, body: string, onClick = () => showWindow()): void {
  if (!Notification.isSupported()) return;
  notice = new Notification({ title, body, icon: iconPath });
  notice.on('click', onClick);
  notice.show();
}

/** Tell the window, refresh the tray, and notify when a check had to fix something nobody saw. */
function reportCheck(entry: HistoryEntry): void {
  lastCheck = entry;
  window?.webContents.send('app:event', 'checked', entry);
  refreshTray();
  if (window?.isVisible() && window.isFocused()) return; // the window shows it
  const automatic = entry.trigger !== 'manual';
  if (automatic && (!prefs.notifyRestores || entry.outcome === 'matched' || entry.outcome === 'remembered')) return;
  const when = automatic ? ` ${WHEN[entry.trigger]}` : '';
  const open = () => showWindow({ settings: true });
  if (entry.outcome === 'restored') {
    notify('Headset settings restored', `${cap(list((entry.restored ?? []).map(lower)))} changed${when}. They’re back the way you set them, confirmed by reading the headset again.`, open);
  } else if (entry.outcome === 'failed') {
    notify('Couldn’t restore headset settings', entry.error ?? `${cap(list((entry.failed ?? []).map((f) => lower(f.group))))} didn’t stick${when}.`, open);
  } else if (entry.outcome === 'matched') {
    notify('Headset settings checked', 'Everything was already the way you set it.', open);
  } else {
    notify('Headset settings remembered', `${APP_NAME} will put these back if they change.`, open);
  }
}

function appState() {
  return {
    version: app.getVersion(),
    update: updates.state,
    prefs: { keepSettings: prefs.keepSettings, notifyRestores: prefs.notifyRestores },
    openAtLogin: { supported: autostart.supported, enabled: autostart.enabled },
    tray: !!tray,
    connected: !!service,
  };
}

ipcMain.handle('app:get', () => appState());
ipcMain.handle('app:set', async (_e, patch: Record<string, unknown>) => {
  try {
    if (typeof patch.openAtLogin === 'boolean') autostart.set(patch.openAtLogin);
    const next = { ...prefs };
    for (const k of ['keepSettings', 'notifyRestores'] as const) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    const turnedOn = next.keepSettings && !prefs.keepSettings;
    setPrefs(next);
    // Turning it on keeps what the headset has now, not whatever was saved last time.
    if (turnedOn) {
      await store.forgetAll();
      keeper.request('manual');
    }
    refreshTray();
    return { state: appState() };
  } catch (err) {
    return { error: (err as Error).message, state: appState() };
  }
});
ipcMain.handle('app:update-check', async () => {
  await updates.check();
  return appState();
});
ipcMain.handle('app:update-install', () => updates.install());
ipcMain.handle('app:check-now', async () => {
  try {
    const entry = await keeper.checkNow();
    return { entry, state: appState() };
  } catch (err) {
    return { error: (err as Error).message, state: appState() };
  }
});
ipcMain.handle('app:remember-now', async () => {
  try {
    const entry = await keeper.rememberNow();
    return { entry, state: appState() };
  } catch (err) {
    if (isLinkError(err)) lose(err);
    return { error: (err as Error).message, state: appState() };
  }
});

// ------------------------------------------------------------------ tray

const clock = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
};

function checkLine(e: HistoryEntry): string {
  const what = {
    matched: 'all settings in place',
    restored: `restored ${list((e.restored ?? []).map(lower))}`,
    failed: 'couldn’t restore everything',
    remembered: 'settings remembered',
  }[e.outcome];
  return `Last check ${clock(e.confirmedAt ?? e.at)}: ${what}`;
}

function createTray(): void {
  try {
    const image = nativeImage.createFromPath(trayIconPath).resize({ width: process.platform === 'darwin' ? 18 : 32, quality: 'best' });
    tray = new Tray(image);
  } catch (err) {
    console.error('no tray icon:', (err as Error).message);
    return;
  }
  tray.on('click', () => (window?.isVisible() && window.isFocused() ? window.hide() : showWindow()));
  refreshTray();
}

function refreshTray(): void {
  if (!tray || shuttingDown) return;
  const s = lastSnapshot;
  const status = !service ? 'Headset not connected' : s ? `${s.battery}% battery` : 'Connected';
  const m = mouse.status;
  const mouseStatus = !m.connected ? 'Not connected' : m.asleep ? 'Asleep' : m.battery ? `${m.battery.percent}% battery${m.battery.charging === 'charging' ? ', charging' : ''}` : 'Connected';
  tray.setToolTip(`${APP_NAME}: ${status}${m.connected ? `\nG502 X PLUS: ${mouseStatus.toLowerCase()}` : ''}`);
  const visible = !!window?.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `A50 X · ${status}`, enabled: false },
    ...(m.connected ? [{ label: `G502 X PLUS · ${mouseStatus}`, enabled: false }] : []),
    ...(prefs.keepSettings && lastCheck ? [{ label: checkLine(lastCheck), enabled: false }] : []),
    { type: 'separator' },
    ...(updates.state.status === 'ready' ? [{ label: `Restart to update to ${updates.state.version}`, click: () => updates.install() }] : []),
    { label: visible ? 'Hide window' : `Open ${APP_NAME}`, click: () => (visible ? window?.hide() : showWindow()) },
    ...(prefs.keepSettings ? [{ label: 'Check headset settings now', enabled: !!service, click: () => void keeper.checkNow() }] : []),
    { label: 'Settings…', click: () => showWindow({ settings: true }) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => shutdown('quit from tray') },
  ]));
}

// ------------------------------------------------------------------ window

// Window size, position and maximized state survive restarts.
const boundsFile = () => userFile('window.json');
function savedBounds(): { bounds: Partial<Electron.Rectangle>; maximized: boolean } | undefined {
  try {
    const b = JSON.parse(readFileSync(boundsFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return undefined;
    // Only reuse the position if it's still on a connected display (e.g. not on an unplugged monitor).
    const visible = screen.getAllDisplays().some(({ workArea: w }) =>
      b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 10 && b.y < w.y + w.height - 80);
    return { bounds: visible ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height }, maximized: !!b.maximized };
  } catch {
    return undefined;
  }
}

/** Set once the window has been shown: a window that never was has no bounds worth saving. */
let shown = false;
let maximizeOnShow = false;

function saveBounds(): void {
  try {
    if (window && !window.isDestroyed() && shown) writeFileSync(boundsFile(), JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch {
    // not worth failing a close over
  }
}

function showWindow({ settings = false } = {}): void {
  if (!window || window.isDestroyed()) return;
  if (maximizeOnShow) {
    maximizeOnShow = false;
    window.maximize();
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  shown = true;
  if (settings) window.webContents.send('app:event', 'open-settings');
}

function createWindow(): void {
  const saved = savedBounds();
  maximizeOnShow = !!saved?.maximized;
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    ...saved?.bounds,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0c0f',
    title: APP_NAME,
    icon: iconPath,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Started at login: run in the tray without opening the window (like G Hub). Without a tray
  // there'd be no way back to it, so then it shows.
  window.once('ready-to-show', () => {
    if (!startHidden || !tray) showWindow();
  });
  window.on('show', refreshTray);
  window.on('hide', refreshTray);
  // Closing the window never quits: the app lives in the tray, and quitting is in the tray's menu.
  window.on('close', (e) => {
    saveBounds();
    if (shuttingDown || quitting || !tray) return;
    e.preventDefault();
    window?.hide();
    if (!prefs.trayHintShown) {
      setPrefs({ ...prefs, trayHintShown: true });
      notify(`${APP_NAME} is still running`, prefs.keepSettings
        ? 'It stays in the tray to keep your headset settings. To quit, right-click the tray icon.'
        : 'It stays in the tray. To quit, right-click the tray icon.');
    }
  });
  // Links (e.g. the README) open in the browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Belt and braces: never keep a meter running for a window that can't show it.
  for (const ev of ['blur', 'minimize', 'hide', 'closed'] as const) window.on(ev as 'hide', () => meters?.stop());
  window.webContents.on('did-start-navigation', () => meters?.stop());
  window.webContents.on('render-process-gone', () => meters?.stop());
  void window.loadFile(join(here, '..', 'renderer', 'index.html'));
}

if (primary) {
  app.whenReady().then(async () => {
    trace(startHidden ? 'ready (hidden)' : 'ready');
    // No menu bar: the app has no menu commands, and on Linux it would sit above the UI.
    Menu.setApplicationMenu(null);
    try {
      const icon = nativeImage.createFromPath(iconPath);
      autostart.installIcons(new Map([16, 22, 24, 32, 48, 64, 128, 256, 512].map((size) =>
        [size, icon.resize({ width: size, height: size, quality: 'best' }).toPNG()])));
      autostart.migrate();
      autostart.refresh();
      autostart.installLauncher();
    } catch (err) {
      console.error('could not update the desktop entries:', (err as Error).message);
    }
    lastCheck = (await store.history().catch(() => []))[0];
    createTray();
    createWindow();
    app.on('activate', () => showWindow());

    // Moments when the headset may have lost its settings.
    powerMonitor.on('suspend', () => {
      trace('suspend');
      keeper.suspend();
    });
    powerMonitor.on('resume', () => {
      trace('resume');
      keeper.request('wake', 4000);
    });
    const unlocked = () => {
      trace('unlock');
      keeper.request('unlock', 1500);
    };
    if (process.platform === 'linux') stopUnlock = watchLinuxUnlock(unlocked);
    else powerMonitor.on('unlock-screen', unlocked);

    updates.start();

    // Poll for hot-plug: connect when the base station appears.
    setInterval(() => {
      if (!service) void connect();
    }, 2000);
  });
}

let shuttingDown = false;
/** A real quit (logout, SIGTERM, Cmd+Q) is under way: closing the window must not just hide it. */
let quitting = false;
app.on('before-quit', () => (quitting = true));

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  trace(`shutting down (${reason})`);
  saveBounds();
  keeper.stop();
  updates.stop();
  stopUnlock?.();
  try {
    service?.device.close();
  } catch {
    // already closed
  }
  service = undefined;
  meters?.stop();
  tray?.destroy();
  // Give the mouse a moment to stop reporting presses and take its LEDs back (a sleeping mouse
  // would not answer; don't wait for it).
  void Promise.race([mouse.close(), new Promise((r) => setTimeout(r, 1000))]).finally(() => {
    // app.exit skips the window-close dance; nothing else needs saving.
    app.exit(0);
  });
}

app.on('window-all-closed', () => shutdown('window closed'));
// On SIGTERM/SIGINT (logout, systemd, Ctrl-C) Electron runs before-quit → will-quit → quit but
// never window-all-closed; node-hid's read thread would then keep the process alive forever.
app.on('will-quit', () => shutdown('will-quit'));
