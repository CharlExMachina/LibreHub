// The MX Brio side of the Electron main process: owns the camera connection and exposes it to the
// window over IPC as brio:snapshot / brio:apply, with brio:changed events. Whenever the camera
// connects (the app starting, the camera plugged in, or back from a restart) the settings you chose
// are put back where the camera differs, as G Hub does: the camera forgets its framing when it restarts.

import { app, type BrowserWindow, type IpcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MxBrio } from '../camera/mxbrio.js';
import { CameraService, type CameraAction, type CameraSnapshot } from '../camera/service.js';
import { CameraStore, defaultCameraFile } from '../camera/store.js';
import { findCamera, openCamera, type CameraTransport } from '../camera/transport.js';

/** Why there is no camera, so the window can say what to do about it. */
export type CameraOffline =
  | { reason: 'not-found' }
  | { reason: 'restarting' }
  | { reason: 'permission'; error: string }
  | { reason: 'error'; error: string };

export interface CameraOptions {
  /** Called when the camera connects or goes (the tray shows it). */
  onStatus?: () => void;
  /** Called when settings had to be put back on connect (names of the settings). */
  onRestored?: (keys: string[]) => void;
  /** Injectable for a simulated camera. */
  find?: () => Promise<unknown>;
  open?: () => Promise<CameraTransport>;
  store?: CameraStore;
}

/** Errors that mean the camera is gone (unplugged, or restarting), not that a value was refused. */
const lost = (err: unknown) => /disconnect|no such device|NO_DEVICE|LIBUSB_ERROR_IO|not found|went away|ENODEV/i.test((err as Error)?.message ?? '');

export function registerCamera(ipcMain: IpcMain, getWindow: () => BrowserWindow | undefined, opts: CameraOptions = {}) {
  const find = opts.find ?? findCamera;
  const open = opts.open ?? (() => openCamera());
  const store = opts.store ?? new CameraStore(defaultCameraFile());
  let service: CameraService | undefined;
  let connecting: Promise<CameraService | undefined> | undefined;
  let closed = false;
  let offline: CameraOffline = { reason: 'not-found' };
  /** After the microphone switch the camera restarts; don't look for it until it has gone. */
  let restartingUntil = 0;
  const notify = (what: string) => getWindow()?.webContents.send('brio:changed', what);

  const disconnect = (why: CameraOffline = { reason: 'not-found' }) => {
    if (!service) return;
    try {
      service.camera.close();
    } catch {
      // already gone
    }
    service = undefined;
    offline = why;
    notify('disconnected');
    opts.onStatus?.();
  };

  const classify = (err: unknown): CameraOffline => {
    const error = (err as Error)?.message ?? String(err);
    if (/permission denied|EACCES|EPERM|LIBUSB_ERROR_ACCESS/i.test(error)) return { reason: 'permission', error };
    if (lost(err)) return { reason: 'not-found' };
    return { reason: 'error', error };
  };

  const connect = async (): Promise<CameraService | undefined> => {
    if (service || closed) return service;
    if (Date.now() < restartingUntil) {
      offline = { reason: 'restarting' };
      return undefined;
    }
    // Cleared once settled (see mouse-ipc.ts for why not in a `finally` inside).
    connecting ??= (async () => {
      try {
        if (!(await find())) {
          offline = { reason: 'not-found' };
          return undefined;
        }
        const svc = new CameraService(new MxBrio(await open()), store);
        const restored = await svc.restore();
        service = svc;
        notify('connected');
        opts.onStatus?.();
        const keys = Object.keys(restored);
        if (keys.length) {
          notify('restored');
          opts.onRestored?.(keys);
        }
        return svc;
      } catch (err) {
        const next = classify(err);
        if (next.reason !== offline.reason) console.error('camera connect failed:', (err as Error).message);
        offline = next;
        return undefined;
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  /** A call failed: a camera that went away is dropped, so the next call reconnects. */
  const failed = (err: unknown) => {
    if (lost(err)) {
      disconnect();
      return { connected: false, offline };
    }
    return { connected: true, error: (err as Error).message };
  };

  const snapshot = async (svc: CameraService): Promise<CameraSnapshot | undefined> => svc.snapshot().catch((err) => {
    failed(err);
    return undefined;
  });

  ipcMain.handle('brio:snapshot', async () => {
    const svc = await connect();
    if (!svc) return { connected: false, offline };
    try {
      return { connected: true, snapshot: await svc.snapshot(), file: store.file };
    } catch (err) {
      return failed(err);
    }
  });

  ipcMain.handle('brio:apply', async (_e, action: CameraAction) => {
    const svc = await connect();
    if (!svc) return { connected: false, offline };
    try {
      await svc.apply(action);
    } catch (err) {
      const f = failed(err);
      return f.connected ? { ...f, snapshot: await snapshot(svc) } : f;
    }
    if (action.type === 'microphone') {
      // The camera restarts to show up with (or without) its microphones: about 2.5 s until it
      // leaves USB, then a second until it is back. Reconnect after that (and put the framing back).
      restartingUntil = Date.now() + 4000;
      disconnect({ reason: 'restarting' });
      return { connected: false, offline };
    }
    return { connected: true, snapshot: await snapshot(svc) };
  });

  /** Save a still from the window's preview (a PNG data URL) where G Hub saves them. */
  ipcMain.handle('brio:save-photo', async (_e, dataUrl: unknown) => {
    const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!m) return { error: 'not a PNG image' };
    const dir = join(app.getPath('pictures'), 'Webcam Snapshots');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    const file = join(dir, `MX Brio ${stamp}.png`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, Buffer.from(m[1], 'base64'));
      return { file };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // Connect when the camera appears; notice when it goes (nothing else tells us on every system).
  const poll = setInterval(async () => {
    if (closed) return;
    if (!service) return void connect().then((svc) => svc || notify('offline'));
    if (!(await find().catch(() => undefined))) disconnect();
  }, 2000);

  return {
    /** Try to connect now. */
    retry: () => void connect(),
    get status() {
      return { connected: !!service };
    },
    async close() {
      closed = true;
      clearInterval(poll);
      try {
        service?.camera.close();
      } catch {
        // already closed
      }
      service = undefined;
    },
  };
}
