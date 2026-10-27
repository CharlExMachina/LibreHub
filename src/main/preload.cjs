// Sandboxed preload: the only bridge between the page and the device.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('a50x', {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke('a50x:snapshot'),
  apply: (action) => ipcRenderer.invoke('a50x:apply', action),
  onChanged: (listener) => ipcRenderer.on('a50x:changed', (_event, what) => listener(what)),
  access: {
    status: () => ipcRenderer.invoke('access:status'),
    allow: () => ipcRenderer.invoke('access:allow'),
    remove: () => ipcRenderer.invoke('access:remove'),
    manual: () => ipcRenderer.invoke('access:manual'),
  },
  audio: {
    status: () => ipcRenderer.invoke('audio:status'),
    setup: () => ipcRenderer.invoke('audio:setup'),
    undo: () => ipcRenderer.invoke('audio:undo'),
  },
  meters: {
    watch: (keys) => ipcRenderer.invoke('meters:watch', keys),
    onLevels: (listener) => ipcRenderer.on('meters:levels', (_event, frame) => listener(frame)),
    onLost: (listener) => ipcRenderer.on('meters:lost', (_event, key) => listener(key)),
  },
  app: {
    get: () => ipcRenderer.invoke('app:get'),
    set: (patch) => ipcRenderer.invoke('app:set', patch),
    checkNow: () => ipcRenderer.invoke('app:check-now'),
    rememberNow: () => ipcRenderer.invoke('app:remember-now'),
    checkForUpdate: () => ipcRenderer.invoke('app:update-check'),
    installUpdate: () => ipcRenderer.invoke('app:update-install'),
    onEvent: (listener) => ipcRenderer.on('app:event', (_event, what, data) => listener(what, data)),
  },
});

contextBridge.exposeInMainWorld('g502x', {
  snapshot: () => ipcRenderer.invoke('g502x:snapshot'),
  live: () => ipcRenderer.invoke('g502x:live'),
  apply: (action) => ipcRenderer.invoke('g502x:apply', action),
  backup: () => ipcRenderer.invoke('g502x:backup'),
  restore: () => ipcRenderer.invoke('g502x:restore'),
  onChanged: (listener) => ipcRenderer.on('g502x:changed', (_event, what) => listener(what)),
});

contextBridge.exposeInMainWorld('brio', {
  snapshot: () => ipcRenderer.invoke('brio:snapshot'),
  apply: (action) => ipcRenderer.invoke('brio:apply', action),
  savePhoto: (dataUrl) => ipcRenderer.invoke('brio:save-photo', dataUrl),
  onChanged: (listener) => ipcRenderer.on('brio:changed', (_event, what) => listener(what)),
});
