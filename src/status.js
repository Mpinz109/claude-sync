// Structured health/status, shared by the CLI `doctor` and the GUI Status screen.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, findBundledCli, claudeRunning } from './platform.js';
import { loadConfig } from './config.js';

// Rule #6: statSync, never Dirent.isDirectory() — these dirs can live under
// OneDrive (reparse points), where Dirent lies and folders get skipped.
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function countSubdirs(dir) {
  try { return fs.readdirSync(dir).filter((n) => isDir(path.join(dir, n))).length; }
  catch { return null; }
}
function countJsonDeep(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (isDir(full)) walk(full);
      else if (name.endsWith('.json')) n++;
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
