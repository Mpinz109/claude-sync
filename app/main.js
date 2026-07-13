// Electron main process. This IS the engine: it loads src/* and exposes it to the
// GUI over IPC. The renderer never touches the filesystem directly.

import { app, BrowserWindow, ipcMain, Tray, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherStatus } from '../src/status.js';
import { loadConfig, saveConfig, setSetting, addProject, linkProjects, setProjectSync, removeDevice } from '../src/config.js';
import { initVault } from '../src/vault.js';
import { pushAll, pullAll, syncAll, discoverProjects, adoptFromVault, status as syncStatus } from '../src/sync.js';
import { runSync } from '../src/run.js';
import { Syncthing } from '../src/syncthing.js';

// Lazy singleton: start the managed Syncthing on first need, reuse after.
let _st = null;
let _stStart = null;
async function syncthing() {
  if (!_st) _st = new Syncthing();
  if (!_stStart) _stStart = _st.start().catch((e) => { _stStart = null; throw e; });
  await _stStart;
  return _st;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    title: 'Claude Sync',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function setupTray() {
  // Tray needs an icon asset (added in the packaging phase). Guard so the app
  // still runs during development without one.
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray.png');
    tray = new Tray(iconPath);
    const menu = Menu.buildFromTemplate([
      { label: 'Open Claude Sync', click: () => { if (!win) createWindow(); else win.show(); } },
      { label: 'Sync now', click: () => win?.webContents.send('action', 'sync-now') },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setToolTip('Claude Sync');
    tray.setContextMenu(menu);
  } catch {
    // no tray icon yet — fine for dev
  }
}

// ---- IPC: the engine surface the GUI calls ----
ipcMain.handle('engine:status', () => gatherStatus());
ipcMain.handle('engine:getConfig', () => loadConfig());
ipcMain.handle('engine:setSetting', (_e, key, value) => setSetting(key, value));
ipcMain.handle('engine:setVault', (_e, dir) => { const c = loadConfig(); c.vaultDir = dir; return saveConfig(c); });
ipcMain.handle('engine:addProject', (_e, name, localPath, gitRemote) => addProject(name, localPath, gitRemote));
ipcMain.handle('engine:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('engine:initVault', (_e, dir) => { const c = loadConfig(); c.vaultDir = dir; saveConfig(c); initVault(dir); return loadConfig(); });
ipcMain.handle('engine:syncStatus', () => syncStatus());
ipcMain.handle('engine:push', () => pushAll());
ipcMain.handle('engine:pull', (_e, opts) => pullAll(undefined, undefined, opts || { dryRun: true }));
ipcMain.handle('engine:syncAll', (_e, opts) => syncAll(undefined, undefined, opts || {}));
ipcMain.handle('engine:runSync', (_e, opts) => runSync(opts || {}));
ipcMain.handle('engine:setProjectSync', (_e, key, enabled) => setProjectSync(key, enabled));
ipcMain.handle('engine:removeDevice', async (_e, key) => {
  const removed = removeDevice(key);
  if (!removed) return { ok: false, error: 'device not found' };
  // Best-effort: also unpair in the managed Syncthing (may not be running/installed).
  let syncthingCleaned = false;
  try { const st = await syncthing(); await st.removeDevice(removed.syncthingId); syncthingCleaned = true; }
  catch { /* config removal is the source of truth; Syncthing cleanup can rerun */ }
  return { ok: true, removed, syncthingCleaned };
});
ipcMain.handle('engine:discover', () => discoverProjects());
ipcMain.handle('engine:adopt', () => adoptFromVault());
ipcMain.handle('engine:linkAll', (_e, list) => linkProjects(list));
// Syncthing-backed device identity + pairing (Phase 4 GUI):
ipcMain.handle('engine:deviceId', async () => {
  try { const st = await syncthing(); return { deviceId: await st.getDeviceId() }; }
  catch (e) { return { deviceId: null, error: String(e.message || e) }; }
});
ipcMain.handle('engine:pair', async (_e, deviceId, name) => {
  try {
    const st = await syncthing();
    await st.addDevice(deviceId.trim(), name);
    const cfg = loadConfig();
    if (!cfg.devices.some((d) => d.syncthingId === deviceId.trim())) {
      cfg.devices.push({ name: name || deviceId.trim().slice(0, 7), syncthingId: deviceId.trim() });
      saveConfig(cfg);
    }
    return { ok: true, devices: (await st.listDevices()).length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('engine:shareVault', async () => {
  try {
    const cfg = loadConfig();
    if (!cfg.vaultDir) return { ok: false, error: 'no vault set' };
    const st = await syncthing();
    await st.shareVault('claude-sync-vault', 'Claude Sync Vault', cfg.vaultDir, cfg.devices.map((d) => d.syncthingId));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

app.whenReady().then(() => {
  createWindow();
  setupTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Keep running in the tray when the window is closed (background presence).
app.on('window-all-closed', () => { /* stay alive for the schedule/tray */ });
