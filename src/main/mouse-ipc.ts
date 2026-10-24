// The G502 X PLUS side of the Electron main process: owns the receiver connection and exposes the
// mouse to the window over IPC as g502x:snapshot / g502x:live / g502x:apply (plus backup and
// restore of its memory), with g502x:changed events. While the app runs (also hidden in the tray)
// it also runs the software agent (software actions and Freestyle lighting), unless
// `librehub mouse agent` already runs one.

import { app, dialog, type BrowserWindow, type IpcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HidTransport } from '../device/transport.js';
import { acquireAgentLock, agentLockHolder, SoftwareAgent } from '../mouse/agent.js';
import { G502X, MouseUnavailableError, TimeoutError } from '../mouse/g502x.js';
import { MouseService, type MouseAction, type MouseSnapshot } from '../mouse/service.js';
import { defaultSoftwareFile, SoftwareStore } from '../mouse/software.js';
import { findReceiver, openReceiver } from '../mouse/transport.js';

/** 'running' = this app performs software actions; 'elsewhere' = `librehub mouse agent` does; 'off' = nobody. */
export type AgentStatus = 'running' | 'elsewhere' | 'off';

/** Why there is no mouse, so the window can say what to do about it. */
export type MouseOffline =
  | { reason: 'not-found' }
  | { reason: 'permission'; error: string }
  | { reason: 'asleep' }
  | { reason: 'error'; error: string };

export interface MouseOptions {
  /** Called when the connection or the battery changes (the tray shows them). */
  onStatus?: () => void;
  /** Injectable for a simulated receiver. */
  find?: () => unknown;
  open?: () => HidTransport & { onError?: (listener: (err: Error) => void) => void };
}

const EVENTS = ['battery', 'connection', 'onboard'];
/** The receiver answered that the mouse is asleep or off. (A receiver that doesn't answer at all is a lost link.) */
const asleep = (err: unknown) => err instanceof MouseUnavailableError;

export function registerMouse(ipcMain: IpcMain, getWindow: () => BrowserWindow | undefined, opts: MouseOptions) {
  const find = opts.find ?? findReceiver;
  const open = opts.open ?? openReceiver;
  let service: MouseService | undefined;
  let connecting: Promise<MouseService | undefined> | undefined;
  let closed = false;
  let offline: MouseOffline = { reason: 'not-found' };
  let last: MouseSnapshot | undefined;
  let sleeping = false;
  const store = new SoftwareStore(defaultSoftwareFile());
  const lockFile = join(dirname(store.file), 'g502x-agent.lock');
  let agent: SoftwareAgent | undefined;
  let releaseLock: (() => void) | undefined;
  const notify = (what: string) => getWindow()?.webContents.send('g502x:changed', what);

  const agentStatus = (): AgentStatus => (agent ? 'running' : agentLockHolder(lockFile) ? 'elsewhere' : 'off');

  /** Remember the newest reading for the tray, and whether the mouse answered. */
  const seen = (snapshot: MouseSnapshot | undefined, isAsleep = false) => {
    const before = `${!!last}|${last?.battery.percent}|${sleeping}`;
    if (snapshot) last = snapshot;
    sleeping = isAsleep;
    if (`${!!last}|${last?.battery.percent}|${sleeping}` !== before) opts.onStatus?.();
    return snapshot;
  };

  const startAgent = async (svc: MouseService) => {
    releaseLock = acquireAgentLock(lockFile) ?? undefined;
    if (!releaseLock) return; // `librehub mouse agent` is running
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
    // Taken now: a reconnect while this one stops installs its own lock and release.
    const release = releaseLock;
    agent = undefined;
    releaseLock = undefined;
    await a?.stop().catch(() => undefined);
    release?.();
  };

  const disconnect = () => {
    void stopAgent();
    try {
      service?.mouse.close();
    } catch {
      // already gone
    }
    service = undefined;
    last = undefined;
    sleeping = false;
    notify('disconnected');
    opts.onStatus?.();
  };

  const classify = (err: unknown): MouseOffline => {
    if (asleep(err)) return { reason: 'asleep' };
    if (err instanceof TimeoutError) return { reason: 'error', error: 'The receiver didn’t answer. Unplug it and plug it back in.' };
    const error = (err as Error)?.message ?? String(err);
    if (/permission denied|EACCES|cannot open device/i.test(error)) return { reason: 'permission', error };
    return { reason: 'error', error };
  };

  const connect = async (): Promise<MouseService | undefined> => {
    if (service || closed) return service;
    // Cleared once settled, not in a `finally` inside: when the body fails before its first await,
    // that would run before the assignment and leave this settled promise in place for good.
    connecting ??= (async () => {
      try {
        if (!find()) {
          offline = { reason: 'not-found' };
          return undefined;
        }
        const transport = open();
        // A short wake window: the mouse sleeps after a few minutes and wakes when moved.
        const mouse = await G502X.connect(transport, { wakeTimeoutMs: 3000 });
        transport.onError?.(() => disconnect());
        for (const ev of EVENTS) mouse.on(ev, () => notify(ev));
        service = new MouseService(mouse, store);
        await startAgent(service);
        notify('connected');
        opts.onStatus?.();
        return service;
      } catch (err) {
        const next = classify(err);
        if (next.reason !== offline.reason) console.error('mouse connect failed:', (err as Error).message);
        offline = next;
        return undefined;
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  /** After a failed read: a receiver that stopped answering is dropped, so the next call reconnects. */
  const failed = (err: unknown) => {
    if (err instanceof TimeoutError) {
      offline = classify(err);
      disconnect();
      return { connected: false, offline };
    }
    // A sleeping mouse is not a lost receiver; keep the connection.
    seen(undefined, asleep(err));
    return { connected: true, agent: agentStatus(), asleep: asleep(err), error: asleep(err) ? undefined : (err as Error).message };
  };

  ipcMain.handle('g502x:snapshot', async () => {
    const svc = await connect();
    if (!svc) return { connected: false, offline };
    try {
      return { connected: true, agent: agentStatus(), snapshot: seen(await svc.snapshot()) };
    } catch (err) {
      return failed(err);
    }
  });

  // What the mouse's own buttons change (profile, DPI level) and the battery: a few quick reads.
  ipcMain.handle('g502x:live', async () => {
    if (!service) return { connected: false, offline };
    try {
      const live = await service.live();
      seen(last && { ...last, battery: live.battery }, false);
      return { connected: true, live };
    } catch (err) {
      return failed(err);
    }
  });

  ipcMain.handle('g502x:apply', async (_e, action: MouseAction) => {
    const svc = await connect();
    if (!svc) return { connected: false, offline };
    try {
      await svc.apply(action);
      await agent?.reload();
    } catch (err) {
      // Asleep: reading it back would only wait for it again.
      if (asleep(err)) return { ...failed(err), error: (err as Error).message };
      if (err instanceof TimeoutError) return failed(err);
      return { connected: true, agent: agentStatus(), error: (err as Error).message, snapshot: seen(await svc.snapshot().catch(() => undefined)) };
    }
    // The change went through; a failed read afterwards isn't a failed change.
    return { connected: true, agent: agentStatus(), snapshot: seen(await svc.snapshot().catch(() => undefined)) };
  });

  ipcMain.handle('g502x:backup', async () => {
    const svc = await connect();
    const win = getWindow();
    if (!svc || !win) return { connected: false, offline };
    const day = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Back up the mouse’s memory',
      defaultPath: join(app.getPath('documents'), `g502x-backup-${day}.json`),
      filters: [{ name: 'Mouse backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { connected: true, canceled: true };
    try {
      await writeFile(filePath, JSON.stringify(await svc.backup(), null, 1));
      return { connected: true, file: filePath };
    } catch (err) {
      return { connected: true, error: (err as Error).message };
    }
  });

  ipcMain.handle('g502x:restore', async () => {
    const svc = await connect();
    const win = getWindow();
    if (!svc || !win) return { connected: false, offline };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore the mouse’s memory from a backup',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'Mouse backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { connected: true, canceled: true };
    try {
      let backup;
      try {
        backup = JSON.parse(await readFile(filePaths[0], 'utf8'));
      } catch {
        throw new Error('that file is not a mouse backup');
      }
      const restored = await svc.restore(backup);
      await agent?.reload();
      return { connected: true, restored, snapshot: seen(await svc.snapshot().catch(() => undefined)) };
    } catch (err) {
      return { connected: true, error: (err as Error).message, snapshot: seen(await svc.snapshot().catch(() => undefined)) };
    }
  });

  const poll = setInterval(() => {
    if (!service) void connect();
  }, 2000);

  return {
    /** Try to connect now (e.g. right after access to the receiver was allowed). */
    retry: () => void connect(),
    /** For the tray: the newest battery reading, and whether the mouse is answering. */
    get status() {
      return { connected: !!service, asleep: sleeping, battery: last?.battery };
    },
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
