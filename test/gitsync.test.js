// Phase 7: git file sync. Pure builders are pinned; the bundle exchange is proven
// end-to-end with two real temp git repos sharing a bundle through a temp vault.
// (Demonstrates the HARD RULE: only a .bundle crosses the vault, never a .git.)

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  bundleDir, bundlePath, bundleCreateArgs, bundleVerifyArgs, fetchBundleArgs,
  fetchRemoteArgs, ffMergeArgs, pushArgs, isGitRepo, currentBranch,
  publish, integrate, filesStatus,
} from '../src/gitsync.js';

const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const mk = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-git-${tag}-`)); tmps.push(d); return d; };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

function initRepo(tag) {
  const d = mk(tag);
  g(d, 'init', '-b', 'main');
  g(d, 'config', 'user.email', 't@t.test');
  g(d, 'config', 'user.name', 'Tester');
  return d;
}
function commit(repo, file, content, msg) {
  fs.writeFileSync(path.join(repo, file), content);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-m', msg);
}

// ---------- pure builders ----------
test('bundle path/dir builders', () => {
  assert.equal(bundleDir('/v', 'P'), path.join('/v', 'projects', 'P', 'git'));
  assert.equal(bundlePath('/v', 'P', 'mA'), path.join('/v', 'projects', 'P', 'git', 'mA.bundle'));
});

test('git arg builders', () => {
  assert.deepEqual(bundleCreateArgs('b.bundle'), ['bundle', 'create', 'b.bundle', '--all']);
  assert.deepEqual(bundleVerifyArgs('b.bundle'), ['bundle', 'verify', 'b.bundle']);
  assert.deepEqual(fetchBundleArgs('b.bundle', 'mA'), ['fetch', 'b.bundle', '+refs/heads/*:refs/remotes/mA/*']);
  assert.deepEqual(fetchRemoteArgs(), ['fetch', 'origin']);
  assert.deepEqual(ffMergeArgs('origin/main'), ['merge', '--ff-only', 'origin/main']);
  assert.deepEqual(pushArgs('origin', 'main'), ['push', 'origin', 'main']);
});

// ---------- repo helpers ----------
test('isGitRepo / currentBranch', () => {
  const r = initRepo('probe');
  commit(r, 'a.txt', '1', 'init');
  assert.equal(isGitRepo(r), true);
  assert.equal(isGitRepo(mk('notrepo')), false);
  assert.equal(currentBranch(r), 'main');
});

// ---------- end-to-end bundle exchange ----------
test('bundle round-trip through the vault: A publishes, B integrates', () => {
  const vault = mk('vault');
  const A = initRepo('A');
  commit(A, 'code.txt', 'v1', 'v1');

  const cfgA = { vaultDir: vault, machineId: 'mA', machineName: 'A' };
  const projA = { id: 'P', name: 'Proj', localPath: A, gitRemote: '' };
  const pub1 = publish(cfgA, projA);
  assert.equal(pub1.mode, 'bundle');
  assert.equal(fs.existsSync(bundlePath(vault, 'P', 'mA')), true);

  // Only a .bundle is in the vault — never a live .git tree (the hard rule).
  const inVault = fs.readdirSync(bundleDir(vault, 'P'));
  assert.deepEqual(inVault, ['mA.bundle']);

  // B starts as a clone of the first bundle.
  const B = mk('B');
  fs.rmSync(B, { recursive: true, force: true }); // git clone wants to create it
  g(os.tmpdir(), 'clone', bundlePath(vault, 'P', 'mA'), B);
  g(B, 'config', 'user.email', 't@t.test');
  g(B, 'config', 'user.name', 'Tester');
  assert.match(g(B, 'log', '--oneline'), /v1/);
  assert.doesNotMatch(g(B, 'log', '--oneline'), /v2/);

  // A advances and re-publishes.
  commit(A, 'code.txt', 'v2', 'v2');
  publish(cfgA, projA);

  // B integrates A's bundle from the vault.
  const cfgB = { vaultDir: vault, machineId: 'mB', machineName: 'B' };
  const projB = { id: 'P', name: 'Proj', localPath: B, gitRemote: '' };
  const r = integrate(cfgB, projB);
  assert.equal(r.mode, 'bundle');
  assert.deepEqual(r.integrated, ['mA']);
  assert.deepEqual(r.conflicts, []);
  assert.match(g(B, 'log', '--oneline'), /v2/, 'B fast-forwarded to A\'s v2');
});

test('integrate skips our own bundle and reports no peers cleanly', () => {
  const vault = mk('vault2');
  const A = initRepo('solo');
  commit(A, 'x', '1', 'init');
  const cfg = { vaultDir: vault, machineId: 'mA', machineName: 'A' };
  const proj = { id: 'P', name: 'P', localPath: A, gitRemote: '' };
  publish(cfg, proj); // writes mA.bundle
  const r = integrate(cfg, proj); // same machine -> own bundle skipped
  assert.deepEqual(r.integrated, []);
  assert.deepEqual(r.conflicts, []);
});

test('filesStatus reports bundle mode + peer count', () => {
  const vault = mk('vault3');
  const A = initRepo('stat');
  commit(A, 'x', '1', 'init');
  const cfg = { vaultDir: vault, machineId: 'mB', machineName: 'B' };
  const proj = { id: 'P', name: 'P', localPath: A, gitRemote: '' };
  // Seed a peer bundle by publishing as a different machine id.
  publish({ ...cfg, machineId: 'mA' }, proj);
  const s = filesStatus(cfg, proj);
  assert.equal(s.mode, 'bundle');
  assert.equal(s.branch, 'main');
  assert.equal(s.peerBundles, 1);
});

test('non-git project is reported, not crashed', () => {
  const cfg = { vaultDir: mk('vault4'), machineId: 'mA', machineName: 'A' };
  const r = publish(cfg, { id: 'P', name: 'Plain', localPath: mk('plain'), gitRemote: '' });
  assert.equal(r.mode, 'none');
});
