// Structured health/status, shared by the CLI `doctor` and the GUI Status screen.

import fs from 'node:fs';
import { resolvePaths, findBundledCli, claudeRunning } from './platform.js';
import { loadConfig } from './config.js';

function countSubdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length; }
  catch { return null; }
}
function countJsonDeep(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) n++;
    }
  };
  try { walk(dir); return n; } catch { return null; }
}

export async function gatherStatus() {
  const p = resolvePaths();
  const cfg = loadConfig();
  return {
    platform: p.platform,
    home: p.home,
    appDataBase: p.appDataBase,
    machineName: cfg.machineName,
    machineId: cfg.machineId,
    vaultDir: cfg.vaultDir || null,
    paths: {
      registration: { path: p.claudeJson, exists: fs.existsSync(p.claudeJson) },
      transcripts: { path: p.transcriptsDir, projectFolders: countSubdirs(p.transcriptsDir) },
      recents: { path: p.recentsDir, entries: countJsonDeep(p.recentsDir) },
      cli: { path: findBundledCli(p) },
    },
    projects: cfg.projects,
    devices: cfg.devices,
    settings: cfg.settings,
    claudeRunning: await claudeRunning(),
  };
}
