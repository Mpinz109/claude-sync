// Phase 7: sync project FILES via git (separate from conversation history).
// Two modes per linked project:
//   - gitRemote set  -> fetch + merge --ff-only, and push local commits.
//   - no shared remote -> exchange git BUNDLES through the vault at
//     vault/projects/<id>/git/<machineId>.bundle.
//
// HARD RULE: a live .git working tree NEVER goes into the vault (Syncthing must
// not touch it). Only single-file bundles cross the vault. We never force-update
// or hard-reset; a non-fast-forward is reported as a conflict, never destroyed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------- pure builders (unit-tested) ----------
export function bundleDir(vaultDir, projectId) {
  return path.join(vaultDir, 'projects', projectId, 'git');
}
export function bundlePath(vaultDir, projectId, machineId) {
  return path.join(bundleDir(vaultDir, projectId), `${machineId}.bundle`);
}
export function bundleCreateArgs(bundleFile, ref = '--all') {
  return ['bundle', 'create', bundleFile, ref];
}
export function bundleVerifyArgs(bundleFile) {
  return ['bundle', 'verify', bundleFile];
}
/** Fetch a bundle's branches into per-peer remote-tracking refs. */
export function fetchBundleArgs(bundleFile, peer) {
  return ['fetch', bundleFile, `+refs/heads/*:refs/remotes/${peer}/*`];
}
export function fetchRemoteArgs(remote = 'origin') {
  return ['fetch', remote];
}
export function ffMergeArgs(ref) {
  return ['merge', '--ff-only', ref];
}
export function pushArgs(remote = 'origin', branch) {
  return branch ? ['push', remote, branch] : ['push', remote];
}

// ---------- git exec ----------
function git(localPath, args) {
  return execFileSync('git', args, { cwd: localPath, encoding: 'utf8', windowsHide: true }).trim();
}
function gitOk(localPath, args) {
  try { git(localPath, args); return true; } catch { return false; }
}
export function isGitRepo(localPath) {
  try { return git(localPath, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}
export function currentBranch(localPath) {
  try { return git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return null; }
}
export function hasRemote(localPath, remote = 'origin') {
  try { return git(localPath, ['remote']).split(/\r?\n/).includes(remote); } catch { return false; }
}
/** The remote's URL, or '' (no repo / no such remote / git missing). */
export function getRemoteUrl(localPath, remote = 'origin') {
  try { return git(localPath, ['remote', 'get-url', remote]); } catch { return ''; }
}

// ---------- per-project operations ----------
/** Publish local commits: push to the shared remote, else write a vault bundle. */
export function publish(cfg, project) {
  const local = project.localPath;
  if (!isGitRepo(local)) return { project: project.name, mode: 'none', reason: 'not a git repo' };
  const branch = currentBranch(local);
  if (project.gitRemote && hasRemote(local)) {
    git(local, pushArgs('origin', branch));
    return { project: project.name, mode: 'remote', pushed: branch };
  }
  fs.mkdirSync(bundleDir(cfg.vaultDir, project.id), { recursive: true });
  const file = bundlePath(cfg.vaultDir, project.id, cfg.machineId);
  git(local, bundleCreateArgs(file, '--all'));
  return { project: project.name, mode: 'bundle', bundle: file };
}

/** Integrate peers' commits: fetch + ff from the remote, or from every peer bundle. */
export function integrate(cfg, project) {
  const local = project.localPath;
  if (!isGitRepo(local)) return { project: project.name, mode: 'none', reason: 'not a git repo' };
  const branch = currentBranch(local);
  if (project.gitRemote && hasRemote(local)) {
    git(local, fetchRemoteArgs('origin'));
    const ff = gitOk(local, ffMergeArgs(`origin/${branch}`));
    return { project: project.name, mode: 'remote', fastForwarded: ff, conflicts: ff ? [] : [branch] };
  }
  const dir = bundleDir(cfg.vaultDir, project.id);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.bundle')); } catch { /* none yet */ }
  const integrated = [], conflicts = [];
  for (const f of files) {
    const peer = f.slice(0, -'.bundle'.length);
    if (peer === cfg.machineId) continue; // never integrate our own bundle
    const file = path.join(dir, f);
    if (!gitOk(local, bundleVerifyArgs(file))) { conflicts.push({ peer, reason: 'bad bundle' }); continue; }
    git(local, fetchBundleArgs(file, peer));
    if (branch && gitOk(local, ffMergeArgs(`refs/remotes/${peer}/${branch}`))) integrated.push(peer);
    else if (branch) conflicts.push({ peer, reason: 'non-fast-forward' }); // left for manual merge, never forced
  }
  return { project: project.name, mode: 'bundle', integrated, conflicts };
}

/** Read-only summary of how a project's files would sync. */
export function filesStatus(cfg, project) {
  const local = project.localPath;
  if (!isGitRepo(local)) return { project: project.name, mode: 'none' };
  const branch = currentBranch(local);
  if (project.gitRemote && hasRemote(local)) return { project: project.name, mode: 'remote', branch };
  const dir = bundleDir(cfg.vaultDir, project.id);
  let peers = 0;
  try {
    peers = fs.readdirSync(dir).filter((f) => f.endsWith('.bundle') && f.slice(0, -7) !== cfg.machineId).length;
  } catch { /* none */ }
  return { project: project.name, mode: 'bundle', branch, peerBundles: peers };
}
