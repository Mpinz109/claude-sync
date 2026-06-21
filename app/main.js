// Electron main process. This IS the engine: it loads src/* and exposes it to the
// GUI over IPC. The renderer never touches the filesystem directly.

import { app, BrowserWindow, ipcMain, Tray, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherStatus } from '../src/status.js';
import { loadConfig, saveConfig, setSetting, addProject, linkProjects } from '../src/config.js';
import { initVault } from '../src/vault.js';
import { pushAll, pullAll, syncAll, discoverProjects, status as syncStatus } from '../src/sync.js';

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
ipcMain.handle('engine:discover', () => discoverProjects());
ipcMain.handle('engine:linkAll', (_e, list) => linkProjects(list));
// Real Device ID lands with the Syncthing manager (phase 4):
ipcMain.handle('engine:deviceId', () => ({ deviceId: null, note: 'Syncthing not bundled yet (phase 4)' }));

app.whenReady().then(() => {
  createWindow();
  setupTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Keep running in the tray when the window is closed (background presence).
app.on('window-all-closed', () => { /* stay alive for the schedule/tray */ });
