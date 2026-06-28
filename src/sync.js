// Orchestration: push (local -> vault) and pull (vault -> local). Phase 3 is
// additive/union-by-cliSessionId; merge + conflict handling is phase 5.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, claudeRunning } from './platform.js';
import { loadConfig, saveConfig, normalizePath } from './config.js';
import { readJson } from './util.js';
import { tokenize, detokenize } from './tokens.js';
import * as vault from './vault.js';
import * as local from './local.js';

function ctx(cfg, paths) {
  return { home: paths.home, machineId: cfg.machineId, machineName: cfg.machineName, vaultDir: cfg.vaultDir };
}

/** local -> vault for one project. Safe to run with Claude open (read-only locally). */
export function pushProject(cfg, project, paths) {
  const home = paths.home;
  vault.ensureProject(cfg.vaultDir, { id: project.id, name: project.name, machineId: cfg.machineId, localPath: project.localPath, gitRemote: project.gitRemote });
  const recentsIndex = local.readRecentsIndex(paths);
  const sessions = local.listLocalSessions(paths, project.localPath, recentsIndex);
  const pushed = [], skipped = [];
  for (const s of sessions) {
    if (vault.vaultHasSession(cfg.vaultDir, project.id, s.cliSessionId)) { skipped.push(s.cliSessionId); continue; }
    const raw = local.readTranscript(s.transcriptPath);
    const transcriptTokenized = tokenize(raw, { home, projectRoot: project.localPath });
    const recentsTokenized = s.recentsEntry ? tokenize(JSON.stringify(s.recentsEntry), { home, projectRoot: project.localPath }) : null;
    const meta = {
      cliSessionId: s.cliSessionId,
      sessionId: s.sessionId,
      title: s.recentsEntry?.title || null,
      model: s.recentsEntry?.model || null,
      createdAt: s.recentsEntry?.createdAt || null,
      lastActivityAt: s.recentsEntry?.lastActivityAt || null,
      hasRecents: !!s.recentsEntry,
      originMachineId: cfg.machineId,
      originMachineName: cfg.machineName,
      contentHash: local.sha256(transcriptTokenized),
    };
    vault.writeVaultSession(cfg.vaultDir, project.id, { cliSessionId: s.cliSessionId, transcriptTokenized, recentsTokenized, meta });
    pushed.push(s.cliSessionId);
  }
  return { project: project.name, pushed, skipped };
}

/** Hash a local session the same way push hashes vault sessions (tokenized). */
function localSessionHash(localSession, home, projectRoot) {
  return local.sha256(tokenize(local.readTranscript(localSession.transcriptPath), { home, projectRoot }));
}

/**
 * vault -> local for one project. Writes Claude state, so Claude must be closed.
 *
 * Phase 5 conflict model. A session present in BOTH local and vault with the SAME
 * contentHash is identical (skipped). DIFFERENT hash = conflict, resolved per
 * settings:
 *   - autoMerge=false                -> report in `conflicts`, change nothing.
 *   - autoMerge=true                 -> newest by lastActivityAt wins; the loser is
 *                                       preserved as `<id>.fork` (never destroyed).
 * Sessions only in the vault are "clean incoming": applied when
 * autoMergeIfNoConflicts !== false, otherwise reported in `available`.
 */
export function pullProject(cfg, project, paths, { dryRun = false } = {}) {
  const home = paths.home;
  const settings = cfg.settings || {};
  const autoMerge = settings.autoMerge === true;
  const applyClean = settings.autoMergeIfNoConflicts !== false; // default true

  const recentsIndex = local.readRecentsIndex(paths);
  const localById = new Map(
    local.listLocalSessions(paths, project.localPath, recentsIndex).map((s) => [s.cliSessionId, s]),
  );
  const sessions = vault.listVaultSessions(cfg.vaultDir, project.id);
  const pulled = [], skipped = [], noRecents = [], conflicts = [], forks = [], available = [];

  // Write a vault session's transcript + recents locally, register the project.
  const apply = (cliSessionId) => {
    const v = vault.readVaultSession(cfg.vaultDir, project.id, cliSessionId);
    const jsonl = detokenize(v.transcriptTokenized, { home, projectRoot: project.localPath });
    local.writeLocalTranscript(paths, project.localPath, cliSessionId, jsonl);
    if (v.recentsTokenized) {
      const entry = JSON.parse(detokenize(v.recentsTokenized, { home, projectRoot: project.localPath }));
      if (!local.writeLocalRecents(paths, entry)) noRecents.push(cliSessionId);
    }
    local.registerProject(paths, project.localPath);
    return jsonl;
  };

  for (const { cliSessionId, meta } of sessions) {
    const localS = localById.get(cliSessionId);

    if (!localS) { // clean incoming
      if (!applyClean) { available.push(cliSessionId); continue; }
      if (dryRun) { pulled.push(cliSessionId); continue; }
      apply(cliSessionId);
      pulled.push(cliSessionId);
      continue;
    }

    // Present on both sides — identical or conflict?
    const localHash = localSessionHash(localS, home, project.localPath);
    if (meta?.contentHash && meta.contentHash === localHash) { skipped.push(cliSessionId); continue; }

    if (!autoMerge) { conflicts.push(cliSessionId); continue; } // report, change nothing
    if (dryRun) { conflicts.push(cliSessionId); continue; }

    // autoMerge: newest by lastActivityAt wins; keep the loser as <id>.fork.
    const localLast = localS.recentsEntry?.lastActivityAt || 0;
    const vaultLast = meta?.lastActivityAt || 0;
    const v = vault.readVaultSession(cfg.vaultDir, project.id, cliSessionId);
    const vaultJsonl = detokenize(v.transcriptTokenized, { home, projectRoot: project.localPath });
    const localRaw = local.readTranscript(localS.transcriptPath);
    if (vaultLast > localLast) {
      local.writeLocalTranscriptFork(paths, project.localPath, cliSessionId, localRaw); // keep old local
      apply(cliSessionId); // vault wins -> becomes the live transcript
      forks.push({ cliSessionId, winner: 'vault', loserKeptAsFork: 'local' });
      pulled.push(cliSessionId);
    } else {
      local.writeLocalTranscriptFork(paths, project.localPath, cliSessionId, vaultJsonl); // keep vault copy
      forks.push({ cliSessionId, winner: 'local', loserKeptAsFork: 'vault' });
    }
  }
  return { project: project.name, pulled, skipped, noRecents, conflicts, forks, available };
}

export function pushAll(cfg = loadConfig(), paths = resolvePaths()) {
  if (!cfg.vaultDir) throw new Error('No vault configured. Run init first.');
  vault.initVault(cfg.vaultDir);
  vault.registerMachine(cfg.vaultDir, cfg.machineId, cfg.machineName);
  return cfg.projects.map((p) => pushProject(cfg, p, paths));
}

export async function pullAll(cfg = loadConfig(), paths = resolvePaths(), { dryRun = false, force = false } = {}) {
  if (!cfg.vaultDir) throw new Error('No vault configured. Run init first.');
  if (!dryRun && !force && await claudeRunning()) {
    return { blocked: true, reason: 'Claude is running. Close it before pulling (it rewrites its own state on launch/quit).' };
  }
  return { blocked: false, results: cfg.projects.map((p) => pullProject(cfg, p, paths, { dryRun })) };
}

/** Full sync of every linked project: push, then (Claude-closed) pull. */
export async function syncAll(cfg = loadConfig(), paths = resolvePaths(), { force = false } = {}) {
  const push = pushAll(cfg, paths);
  const pull = await pullAll(cfg, paths, { dryRun: false, force });
  return { push, pull };
}

/** Discover local Claude projects not yet linked (from .claude.json + recents cwds). */
export function discoverProjects(paths = resolvePaths(), cfg = loadConfig()) {
  const linked = new Set(cfg.projects.map((p) => p.localPath));
  const found = new Map(); // localPath -> name
  try {
    const j = readJson(paths.claudeJson, {});
    for (const p of Object.keys(j.projects || {})) {
      if (!linked.has(p) && fs.existsSync(p)) found.set(p, path.basename(p));
    }
  } catch { /* no registration */ }
  for (const { entry } of local.readRecentsIndex(paths).values()) {
    const cwd = entry.cwd;
    if (cwd && !linked.has(cwd) && fs.existsSync(cwd)) found.set(cwd, path.basename(cwd));
  }
  return [...found].map(([localPath, name]) => ({ name, localPath }));
}

/**
 * Build a name -> localPath map of candidate local folders. Combines discovered
 * projects (registration + recents) with a filesystem scan of the parent dirs of
 * those known projects, so bare on-disk folders that were never registered with
 * Claude are still matchable by name. First match for a name wins.
 */
function localFolderIndex(paths, cfg) {
  const index = new Map();
  const add = (name, p) => { if (name && p && !index.has(name)) index.set(name, p); };
  const discovered = discoverProjects(paths, cfg);
  for (const d of discovered) add(d.name, d.localPath);
  // Roots = parent dirs of every path we already know about.
  const roots = new Set();
  for (const p of [...cfg.projects.map((x) => x.localPath), ...discovered.map((d) => d.localPath)]) {
    if (p) roots.add(path.dirname(path.resolve(p)));
  }
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      // NOTE: do NOT use readdir({withFileTypes}) + Dirent.isDirectory() here —
      // OneDrive-backed folders are reparse points and report isDirectory()===false.
      // statSync follows the reparse and gives the correct answer.
      const full = path.join(root, name);
      try { if (fs.statSync(full).isDirectory()) add(name, full); } catch { /* skip */ }
    }
  }
  return index;
}

/**
 * Adopt the vault's projects on a NEW machine: link each vault project to a local
 * folder (matched by name, or a path the vault already recorded for this machine),
 * reusing the vault's project id so pull/push line up across machines.
 *
 * - BUG2 fix: matches bare on-disk folders, not only registered/recents projects.
 * - BUG1 fix: never links two vault records to the same local folder (path-deduped,
 *   normalized for slash/case); extra records land in `duplicates`.
 */
export function adoptFromVault(cfg = loadConfig(), paths = resolvePaths()) {
  if (!cfg.vaultDir) throw new Error('No vault configured. Run init first.');
  const projectsDir = path.join(cfg.vaultDir, 'projects');
  const byName = localFolderIndex(paths, cfg);
  const adopted = [], unmatched = [], already = [], duplicates = [];
  const claimed = new Set(cfg.projects.map((p) => normalizePath(p.localPath)));
  let ids = [];
  try { ids = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
  for (const id of ids) {
    const pj = readJson(path.join(projectsDir, id, 'project.json'), null);
    if (!pj) continue;
    if (cfg.projects.some((p) => p.id === pj.id)) { already.push(pj.name); continue; }
    const recorded = pj.machines?.[cfg.machineId]?.localPath;
    const localPath = (recorded && fs.existsSync(recorded)) ? recorded : byName.get(pj.name);
    if (!localPath) { unmatched.push(pj.name); continue; }
    const np = normalizePath(localPath);
    if (claimed.has(np)) { duplicates.push(pj.name); continue; } // same folder already linked
    cfg.projects.push({ id: pj.id, name: pj.name, localPath, gitRemote: pj.gitRemote || '' });
    claimed.add(np);
    adopted.push({ name: pj.name, localPath });
  }
  saveConfig(cfg);
  return { adopted, unmatched, already, duplicates };
}

/** What would move, per project — including diverged sessions (conflicts). */
export function status(cfg = loadConfig(), paths = resolvePaths()) {
  const recentsIndex = local.readRecentsIndex(paths);
  return cfg.projects.map((p) => {
    const localSessions = local.listLocalSessions(paths, p.localPath, recentsIndex);
    const localById = new Map(localSessions.map((s) => [s.cliSessionId, s]));
    const localIds = new Set(localById.keys());
    const vaultSessions = vault.listVaultSessions(cfg.vaultDir, p.id);
    const vaultIds = new Set(vaultSessions.map((s) => s.cliSessionId));
    const toPush = [...localIds].filter((id) => !vaultIds.has(id));
    const toPull = [...vaultIds].filter((id) => !localIds.has(id));
    // Conflict = present in both with a different contentHash.
    let conflicts = 0;
    for (const vs of vaultSessions) {
      const ls = localById.get(vs.cliSessionId);
      if (!ls || !vs.meta?.contentHash) continue;
      if (localSessionHash(ls, paths.home, p.localPath) !== vs.meta.contentHash) conflicts++;
    }
    return {
      project: p.name, localPath: p.localPath,
      local: localIds.size, vault: vaultIds.size,
      toPush: toPush.length, toPull: toPull.length, conflicts,
    };
  });
}
