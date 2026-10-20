// The G502 X PLUS side of the Electron main process: owns the receiver connection and exposes the
// mouse to the window over IPC as g502x:snapshot / g502x:apply, with g502x:changed events.

import type { BrowserWindow, IpcMain } from 'electron';
import { G502X } from '../mouse/g502x.js';
import { MouseService, type MouseAction } from '../mouse/service.js';
import { findReceiver, openReceiver } from '../mouse/transport.js';

const EVENTS = ['battery', 'connection', 'onboard'];

export function registerMouse(ipcMain: IpcMain, getWindow: () => BrowserWindow | undefined) {
  let service: MouseService | undefined;
  let connecting: Promise<MouseService | undefined> | undefined;
  let closed = false;
  const notify = (what: string) => getWindow()?.webContents.send('g502x:changed', what);

  const disconnect = () => {
    try {
      service?.mouse.close();
    } catch {
      // already gone
    }
    service = undefined;
    notify('disconnected');
  };

  const connect = async (): Promise<MouseService | undefined> => {
    if (service || closed) return service;
    connecting ??= (async () => {
      try {
        if (!findReceiver()) return undefined;
        const transport = openReceiver();
        // A short wake window: the mouse sleeps after a few minutes and wakes when moved.
        const mouse = await G502X.connect(transport, { wakeTimeoutMs: 3000 });
        transport.onError(() => disconnect());
        for (const ev of EVENTS) mouse.on(ev, () => notify(ev));
        service = new MouseService(mouse);
        notify('connected');
        return service;
      } catch (err) {
        console.error('mouse connect failed:', (err as Error).message);
        return undefined;
      } finally {
        connecting = undefined;
      }
    })();
    return connecting;
  };

  ipcMain.handle('g502x:snapshot', async () => {
    const svc = await connect();
    if (!svc) return { connected: false };
    try {
      return { connected: true, snapshot: await svc.snapshot() };
    } catch (err) {
      // A sleeping mouse is not a lost receiver; keep the connection.
      return { connected: true, error: (err as Error).message };
    }
  });

  ipcMain.handle('g502x:apply', async (_e, action: MouseAction) => {
    const svc = await connect();
    if (!svc) return { connected: false };
    try {
      await svc.apply(action);
      return { connected: true, snapshot: await svc.snapshot() };
    } catch (err) {
      return { connected: true, error: (err as Error).message, snapshot: await svc.snapshot().catch(() => undefined) };
    }
  });

  const poll = setInterval(() => {
    if (!service) void connect();
  }, 2000);

  return {
    close() {
      closed = true;
      clearInterval(poll);
      try {
        service?.mouse.close();
      } catch {
        // already closed
      }
      service = undefined;
    },
  };
}
