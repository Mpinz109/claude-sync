// Persistent config + settings store, shared by the CLI engine and the GUI.
// Lives at ~/.claude-sync/config.json (outside any synced/vault folder).

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJson, writeJson } from './util.js';

export const CONFIG_DIR = path.join(os.homedir(), '.claude-sync');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Canonicalize a path for equality comparison: absolute, forward-slashed, no
 * trailing slash, and lowercased on case-insensitive filesystems (Windows,
 * macOS). Use this whenever comparing two localPaths — raw string compare misses
 * `C:\a` vs `C:/a` vs `C:\A`.
 */
export function normalizePath(p) {
  if (!p) return '';
  let r = path.resolve(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') r = r.toLowerCase();
  return r;
}

export const DEFAULT_SETTINGS = {
  autoMerge: false,             // auto-resolve UNRELATED conflicts by newest, loser kept as .fork
  autoMergeIfNoConflicts: true, // legacy boolean; superseded by incomingPolicy (kept for back-compat)
  incomingPolicy: 'ff-only',    // 'ff-only' (apply only if unchanged here — safest, default) | 'merge' (lossless union) | 'manual' (report only)
  promptOnOpen: true,           // run the pull prompt when Claude opens
  scheduleAt: '03:00',          // daily background job time
  schedulePushOnly: true,       // legacy toggle; superseded by syncMode (kept for back-compat)
  syncMode: 'push',             // 'push' | 'push-cloud' | 'full' — what `sync` and the scheduled job do
  awsDiscovery: '',             // optional self-hosted Syncthing discovery/relay URL
  projectsRoot: '',             // folder to scan for project folders during `adopt` (seeds a fresh machine)
  machineRole: '',              // '' | 'primary' | 'secondary' — primary is the source of truth on conflicts
  s3Bucket: '',                 // cloud vault mirror: bucket name ('' = cloud sync off)
  s3Region: 'eu-west-1',        // bucket region
  s3Prefix: 'vault/',           // key prefix inside the bucket
  awsProfile: 'default',        // ~/.aws/credentials profile (env vars win if set)
  vaultPassphrase: '',          // optional: client-side AES-256-GCM for every cloud object
};

function defaults() {
  return {
    version: 1,
    machineId: crypto.randomUUID(),
    machineName: os.hostname(),
    vaultDir: '',          // the Syncthing-shared vault (set during onboarding)
    projects: [],          // [{ id, name, localPath, gitRemote }]
    devices: [],           // paired machines: [{ name, syncthingId }]
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = defaults();
    writeJson(CONFIG_FILE, cfg);
    return cfg;
  }
  const cfg = readJson(CONFIG_FILE);
  const raw = cfg.settings || {};
  cfg.settings = { ...DEFAULT_SETTINGS, ...raw }; // fill new keys
  // Back-compat: users who had turned OFF push-only before syncMode existed
  // clearly wanted two-way — carry that intent forward.
  if (raw.syncMode == null && raw.schedulePushOnly === false) cfg.settings.syncMode = 'full';
  // Back-compat: autoMergeIfNoConflicts=false predates incomingPolicy.
  if (raw.incomingPolicy == null && raw.autoMergeIfNoConflicts === false) cfg.settings.incomingPolicy = 'manual';
  // Back-compat: projects linked before per-project sync existed are enabled.
  cfg.projects = (cfg.projects || []).map((p) => ({ ...p, syncEnabled: p.syncEnabled !== false }));
  return cfg;
}

/** Find a linked project by name (case-insensitive) or by local path. */
export function findProject(cfg, key) {
  const nk = normalizePath(key);
  const lk = String(key).toLowerCase();
  return cfg.projects.find((p) => p.name.toLowerCase() === lk || normalizePath(p.localPath) === nk) || null;
}

/** Pure core of device removal (unit-testable): match by Syncthing id or name. */
export function removeDeviceFrom(cfg, key) {
  const lk = String(key).toLowerCase();
  const i = (cfg.devices || []).findIndex((d) => d.syncthingId === key || (d.name || '').toLowerCase() === lk);
  if (i < 0) return null;
  return cfg.devices.splice(i, 1)[0];
}

/** Remove a paired computer from the config. Returns the removed device or null. */
export function removeDevice(key) {
  const cfg = loadConfig();
  const removed = removeDeviceFrom(cfg, key);
  if (removed) saveConfig(cfg);
  return removed;
}

/** Turn syncing on/off for one linked project. Returns the project or null. */
export function setProjectSync(key, enabled) {
  const cfg = loadConfig();
  const p = findProject(cfg, key);
  if (!p) return null;
  p.syncEnabled = !!enabled;
  saveConfig(cfg);
  return p;
}

export function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

export function getSetting(key) {
  return loadConfig().settings[key];
}

export function setSetting(key, value) {
  const cfg = loadConfig();
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${key}`);
  cfg.settings[key] = value;
  return saveConfig(cfg);
}

export function addProject(name, localPath, gitRemote = '') {
  const cfg = loadConfig();
  const id = crypto.randomUUID();
  cfg.projects.push({ id, name, localPath, gitRemote, syncEnabled: true });
  saveConfig(cfg);
  return id;
}

/** Link a batch of projects, skipping any whose localPath is already linked. */
export function linkProjects(list) {
  const cfg = loadConfig();
  let added = 0;
  const seen = new Set(cfg.projects.map((p) => normalizePath(p.localPath)));
  for (const { name, localPath, gitRemote = '' } of list) {
    const np = normalizePath(localPath);
    if (!seen.has(np)) {
      cfg.projects.push({ id: crypto.randomUUID(), name, localPath, gitRemote, syncEnabled: true });
      seen.add(np);
      added++;
    }
  }
  saveConfig(cfg);
  return { added, total: cfg.projects.length };
}
