// The canonical "vault" — a Syncthing-shared folder holding machine-independent
// (tokenized) session data. Layout:
//   vault/vault.json
//   vault/projects/<projectId>/project.json
//   vault/projects/<projectId>/sessions/<cliSessionId>/{transcript.jsonl,recents.json,meta.json}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, writeText, readText } from './util.js';

export function initVault(dir) {
  const metaFile = path.join(dir, 'vault.json');
  if (!fs.existsSync(metaFile)) {
    writeJson(metaFile, { version: 1, vaultId: crypto.randomUUID(), machines: {} });
  }
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return readJson(metaFile);
}

export function loadVaultMeta(dir) {
  return readJson(path.join(dir, 'vault.json'));
}

export function registerMachine(dir, machineId, machineName, role = '') {
  const f = path.join(dir, 'vault.json');
  const m = readJson(f);
  const prev = m.machines[machineId] || {};
  m.machines[machineId] = { ...prev, name: machineName, lastSeen: null };
  if (role) {
    m.machines[machineId].role = role;
    // Single-primary invariant: claiming primary demotes any other primary.
    if (role === 'primary') {
      for (const [id, rec] of Object.entries(m.machines)) {
        if (id !== machineId && rec.role === 'primary') rec.role = 'secondary';
      }
    }
  }
  writeJson(f, m);
}

/** The machineId currently registered as primary in this vault, or null. */
export function getPrimaryMachineId(dir) {
  const m = readJson(path.join(dir, 'vault.json'), null);
  if (!m) return null;
  for (const [id, rec] of Object.entries(m.machines || {})) {
    if (rec.role === 'primary') return id;
  }
  return null;
}

function projDir(dir, projectId) { return path.join(dir, 'projects', projectId); }
function sessDir(dir, projectId, cliSessionId) { return path.join(projDir(dir, projectId), 'sessions', cliSessionId); }

export function ensureProject(dir, { id, name, machineId, localPath, gitRemote = '' }) {
  const f = path.join(projDir(dir, id), 'project.json');
  let rec = fs.existsSync(f) ? readJson(f) : { id, name, gitRemote, machines: {} };
  rec.name = name || rec.name;
  if (gitRemote) rec.gitRemote = gitRemote;
  if (machineId) rec.machines[machineId] = { localPath };
  fs.mkdirSync(path.join(projDir(dir, id), 'sessions'), { recursive: true });
  writeJson(f, rec);
  return rec;
}

export function loadProject(dir, projectId) {
  const f = path.join(projDir(dir, projectId), 'project.json');
  return fs.existsSync(f) ? readJson(f) : null;
}

export function vaultHasSession(dir, projectId, cliSessionId) {
  return fs.existsSync(path.join(sessDir(dir, projectId, cliSessionId), 'meta.json'));
}

export function listVaultSessions(dir, projectId) {
  const base = path.join(projDir(dir, projectId), 'sessions');
  try {
    // Rule #6: the vault may live under OneDrive, where entries are reparse
    // points and Dirent.isDirectory() lies — statSync each entry instead.
    return fs.readdirSync(base)
      .filter((name) => { try { return fs.statSync(path.join(base, name)).isDirectory(); } catch { return false; } })
      .map((name) => ({ cliSessionId: name, meta: readJson(path.join(base, name, 'meta.json'), {}) }));
  } catch { return []; }
}

export function writeVaultSession(dir, projectId, { cliSessionId, transcriptTokenized, recentsTokenized, meta }) {
  const d = sessDir(dir, projectId, cliSessionId);
  writeText(path.join(d, 'transcript.jsonl'), transcriptTokenized);
  if (recentsTokenized != null) writeText(path.join(d, 'recents.json'), recentsTokenized);
  writeJson(path.join(d, 'meta.json'), meta);
}

export function readVaultSession(dir, projectId, cliSessionId) {
  const d = sessDir(dir, projectId, cliSessionId);
  const recentsFile = path.join(d, 'recents.json');
  return {
    transcriptTokenized: readText(path.join(d, 'transcript.jsonl')),
    recentsTokenized: fs.existsSync(recentsFile) ? readText(recentsFile) : null,
    meta: readJson(path.join(d, 'meta.json')),
  };
}
