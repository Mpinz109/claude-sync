// Maintenance: clean up the duplicate-project mess that a folder move (or a
// history import) leaves behind.
//
// Two symptoms, two fixes:
//  1. tidyRegistration — .claude.json keeps registration entries keyed by the
//     project's absolute path. After a move, the OLD path's entry survives next
//     to the new one, so the Claude app lists the project twice (one dead).
//     Remove entries whose path no longer exists, and collapse slash/case
//     variants of the same path onto one key.
//  2. dedupeVault — a vault can accumulate two project records with the same
//     name (e.g. one created from a pre-move history import and one from a
//     post-move push). Sessions end up split across the two ids. Merge the
//     duplicate's sessions into the canonical record and retire the duplicate
//     (its project.json becomes merged.json — data is moved, never destroyed).
//
// Both are dry-run by default; callers pass {apply:true} to write.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from './platform.js';
import { loadConfig, normalizePath } from './config.js';
import { readJson, writeJson } from './util.js';

/**
 * Remove dead / slash-variant project registrations from .claude.json.
 * - A key is dead when its path no longer exists on disk.
 * - When two keys normalize to the same path, one survives (flags merged).
 * - A surviving key that is a slash/case variant of a LINKED project's
 *   localPath is REKEYED to the linked spelling, so raw-string consumers
 *   (including already-shipped app builds) see them as the same project.
 * Returns { removed, merged, rekeyed, kept }.
 */
export function tidyRegistration(paths = resolvePaths(), { apply = false, cfg = loadConfig() } = {}) {
  const file = paths.claudeJson;
  const reg = readJson(file, null);
  if (!reg || !reg.projects) return { removed: [], merged: [], rekeyed: [], kept: 0 };

  const keys = Object.keys(reg.projects);
  const removed = [], merged = [], rekeyed = [];
  const byNorm = new Map(); // normalized -> surviving key
  const linkedByNorm = new Map(cfg.projects.map((p) => [normalizePath(p.localPath), p.localPath]));

  for (const key of keys) {
    if (!fs.existsSync(key)) { removed.push(key); continue; } // dead path
    const nk = normalizePath(key);
    const prev = byNorm.get(nk);
    if (prev === undefined) { byNorm.set(nk, key); continue; }
    // Slash/case variant of a path we already kept — merge flags into survivor.
    merged.push(key);
    reg.projects[prev] = { ...reg.projects[key], ...reg.projects[prev] };
  }

  // Rekey survivors whose spelling differs from the linked project's path.
  for (const [nk, key] of byNorm) {
    const linkedSpelling = linkedByNorm.get(nk);
    if (linkedSpelling && linkedSpelling !== key) {
      rekeyed.push({ from: key, to: linkedSpelling });
      reg.projects[linkedSpelling] = reg.projects[key];
      byNorm.set(nk, linkedSpelling);
      merged.push(key); // schedule the old spelling for deletion
    }
  }

  if (apply && (removed.length || merged.length)) {
    for (const k of [...removed, ...merged]) delete reg.projects[k];
    writeJson(file, reg); // BOM-free
  }
  return { removed, merged: merged.filter((k) => !rekeyed.some((r) => r.from === k)), rekeyed, kept: byNorm.size };
}

/**
 * Merge duplicate vault project records (same name, different ids).
 * Canonical = the id linked in this machine's config if any, else the record
 * with the most sessions. Duplicate sessions whose cliSessionId already exists
 * in the canonical record are left in place and reported (never clobbered).
 * The retired record's project.json is renamed to merged.json so scans skip it.
 * If the local config linked a retired id, it is repointed to the canonical.
 */
export function dedupeVault(cfg = loadConfig(), { apply = false } = {}) {
  if (!cfg.vaultDir) throw new Error('No vault configured. Run init first.');
  const projectsDir = path.join(cfg.vaultDir, 'projects');
  const records = [];
  let ids = [];
  // Rule #6: the vault may live under OneDrive — statSync, never Dirent.isDirectory().
  try {
    ids = fs.readdirSync(projectsDir)
      .filter((n) => { try { return fs.statSync(path.join(projectsDir, n)).isDirectory(); } catch { return false; } });
  } catch { return { merged: [], conflictsLeft: [], repointed: [] }; }

  for (const id of ids) {
    const pj = readJson(path.join(projectsDir, id, 'project.json'), null);
    if (!pj) continue; // already retired (merged.json) or malformed
    const sessDir = path.join(projectsDir, id, 'sessions');
    let sessions = [];
    try {
      sessions = fs.readdirSync(sessDir)
        .filter((n) => { try { return fs.statSync(path.join(sessDir, n)).isDirectory(); } catch { return false; } });
    } catch { /* none */ }
    records.push({ id, name: pj.name, pj, sessions });
  }

  const byName = new Map();
  for (const r of records) {
    const k = r.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }

  const linkedIds = new Set(cfg.projects.map((p) => p.id));
  const merged = [], conflictsLeft = [], repointed = [];

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    // Pick the canonical record.
    group.sort((a, b) =>
      (linkedIds.has(b.id) - linkedIds.has(a.id)) || (b.sessions.length - a.sessions.length));
    const canon = group[0];
    for (const dup of group.slice(1)) {
      const moved = [], skipped = [];
      for (const sid of dup.sessions) {
        const src = path.join(projectsDir, dup.id, 'sessions', sid);
        const dst = path.join(projectsDir, canon.id, 'sessions', sid);
        if (fs.existsSync(dst)) { skipped.push(sid); conflictsLeft.push({ name: canon.name, cliSessionId: sid, leftIn: dup.id }); continue; }
        if (apply) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
        moved.push(sid);
      }
      if (apply) {
        // Fold the duplicate's machines map into the canonical record.
        const canonFile = path.join(projectsDir, canon.id, 'project.json');
        const canonPj = readJson(canonFile);
        canonPj.machines = { ...(dup.pj.machines || {}), ...(canonPj.machines || {}) };
        writeJson(canonFile, canonPj);
        // Retire the duplicate: project.json -> merged.json (scans skip it, data kept).
        const dupFile = path.join(projectsDir, dup.id, 'project.json');
        writeJson(path.join(projectsDir, dup.id, 'merged.json'), { ...dup.pj, mergedInto: canon.id });
        fs.rmSync(dupFile);
        // Repoint a local link at the retired id (mutates cfg; caller persists).
        const link = cfg.projects.find((p) => p.id === dup.id);
        if (link) { link.id = canon.id; repointed.push(canon.name); }
      }
      merged.push({ name: canon.name, canonical: canon.id, retired: dup.id, moved, skipped });
    }
  }
  return { merged, conflictsLeft, repointed };
}
