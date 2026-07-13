// Bridge between the sandboxed renderer and the engine in the main process.
// CommonJS (.cjs) on purpose: preload scripts are not ES modules.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('engine:status'),
  getConfig: () => ipcRenderer.invoke('engine:getConfig'),
  setSetting: (key, value) => ipcRenderer.invoke('engine:setSetting', key, value),
  setVault: (dir) => ipcRenderer.invoke('engine:setVault', dir),
  addProject: (name, localPath, gitRemote) => ipcRenderer.invoke('engine:addProject', name, localPath, gitRemote),
  deviceId: () => ipcRenderer.invoke('engine:deviceId'),
  pair: (deviceId, name) => ipcRenderer.invoke('engine:pair', deviceId, name),
  shareVault: () => ipcRenderer.invoke('engine:shareVault'),
  initVault: (dir) => ipcRenderer.invoke('engine:initVault', dir),
  syncStatus: () => ipcRenderer.invoke('engine:syncStatus'),
  push: () => ipcRenderer.invoke('engine:push'),
  pull: (opts) => ipcRenderer.invoke('engine:pull', opts),
  syncAll: (opts) => ipcRenderer.invoke('engine:syncAll', opts),
  runSync: (opts) => ipcRenderer.invoke('engine:runSync', opts),
  discover: () => ipcRenderer.invoke('engine:discover'),
  adopt: () => ipcRenderer.invoke('engine:adopt'),
  linkAll: (list) => ipcRenderer.invoke('engine:linkAll', list),
  openExternal: (url) => ipcRenderer.invoke('engine:openExternal', url),
  onAction: (cb) => ipcRenderer.on('action', (_e, name) => cb(name)),
});
