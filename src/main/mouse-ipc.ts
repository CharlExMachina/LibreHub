// The G502 X PLUS side of the Electron main process: owns the receiver connection and exposes the
// mouse to the window over IPC as g502x:snapshot / g502x:apply, with g502x:changed events. While
// the app runs (also hidden in the tray) it also runs the software agent (software actions and
// Freestyle lighting), unless `g502x agent` already runs one.

import type { BrowserWindow, IpcMain } from 'electron';
import { dirname, join } from 'node:path';
import { acquireAgentLock, agentLockHolder, SoftwareAgent } from '../mouse/agent.js';
import { G502X } from '../mouse/g502x.js';
import { MouseService, type MouseAction } from '../mouse/service.js';
import { defaultSoftwareFile, SoftwareStore } from '../mouse/software.js';
import { findReceiver, openReceiver } from '../mouse/transport.js';

/** 'running' = this app performs software actions; 'elsewhere' = `g502x agent` does; 'off' = nobody. */
export type AgentStatus = 'running' | 'elsewhere' | 'off';

const EVENTS = ['battery', 'connection', 'onboard'];

export function registerMouse(ipcMain: IpcMain, getWindow: () => BrowserWindow | undefined) {
  let service: MouseService | undefined;
  let connecting: Promise<MouseService | undefined> | undefined;
  let closed = false;
  const store = new SoftwareStore(defaultSoftwareFile());
  const lockFile = join(dirname(store.file), 'g502x-agent.lock');
  let agent: SoftwareAgent | undefined;
  let releaseLock: (() => void) | undefined;
  const notify = (what: string) => getWindow()?.webContents.send('g502x:changed', what);

  const agentStatus = (): AgentStatus => (agent ? 'running' : agentLockHolder(lockFile) ? 'elsewhere' : 'off');

  const startAgent = async (svc: MouseService) => {
    releaseLock = acquireAgentLock(lockFile) ?? undefined;
    if (!releaseLock) return; // `g502x agent` is running
    agent = new SoftwareAgent(svc, store, { watch: true });
    agent.on('error', (err) => console.error('mouse agent:', (err as Error).message));
    agent.on('action', () => notify('action'));
    try {
      await agent.start();
    } catch (err) {
      console.error('mouse agent failed to start:', (err as Error).message);
      await stopAgent();
    }
  };

  const stopAgent = async () => {
    const a = agent;
    agent = undefined;
    await a?.stop().catch(() => undefined);
    releaseLock?.();
    releaseLock = undefined;
  };

  const disconnect = () => {
    void stopAgent();
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
        service = new MouseService(mouse, store);
        await startAgent(service);
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
      return { connected: true, agent: agentStatus(), snapshot: await svc.snapshot() };
    } catch (err) {
      // A sleeping mouse is not a lost receiver; keep the connection.
      return { connected: true, agent: agentStatus(), error: (err as Error).message };
    }
  });

  ipcMain.handle('g502x:apply', async (_e, action: MouseAction) => {
    const svc = await connect();
    if (!svc) return { connected: false };
    try {
      await svc.apply(action);
      await agent?.reload();
      return { connected: true, agent: agentStatus(), snapshot: await svc.snapshot() };
    } catch (err) {
      return { connected: true, error: (err as Error).message, snapshot: await svc.snapshot().catch(() => undefined) };
    }
  });

  const poll = setInterval(() => {
    if (!service) void connect();
  }, 2000);

  return {
    async close() {
      closed = true;
      clearInterval(poll);
      await stopAgent();
      try {
        service?.mouse.close();
      } catch {
        // already closed
      }
      service = undefined;
    },
  };
}
