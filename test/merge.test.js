// v0.2 sync semantics: related divergence merges LOSSLESSLY (entry-level union,
// src/treemerge.js); continued sessions propagate to the vault on push; only
// UNRELATED content under the same session id is a true conflict (fork path).
// All on temp machine profiles + a temp vault — no real Claude state.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/platform.js';
import { writeText, writeJson, readText } from '../src/util.js';
import { initVault, readVaultSession } from '../src/vault.js';
import { pushProject, pullProject, status } from '../src/sync.js';

const PROJ = 'p-merge';
const S = 'S0000000-0000-0000-0000-000000000000';
const T = 'T0000000-0000-0000-0000-000000000000';
const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function makeMachine(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cs-merge-${tag}-`));
  tmps.push(root);
  const home = path.join(root, 'home');
  const projectRoot = path.join(home, 'RCP', 'Proj');
  fs.mkdirSync(projectRoot, { recursive: true });
  const paths = {
    platform: process.platform, home,
    appDataBase: path.join(root, 'appdata'),
    claudeJson: path.join(home, '.claude.json'),
    transcriptsDir: path.join(home, '.claude', 'projects'),
    recentsDir: path.join(root, 'appdata', 'claude-code-sessions'),
    cliDir: path.join(root, 'appdata', 'claude-code'),
  };
  return { root, paths, projectRoot };
}

const tFile = (m, root, id) => path.join(m.paths.transcriptsDir, encodeCwd(root), `${id}.jsonl`);
const forkFile = (m, root, id) => path.join(m.paths.transcriptsDir, encodeCwd(root), `${id}.fork`);
const undoFiles = (m, root) => {
  try { return fs.readdirSync(path.join(m.paths.transcriptsDir, encodeCwd(root))).filter((f) => f.endsWith('.undo')); }
  catch { return []; }
};
const recents = (m, obj) => writeJson(path.join(m.paths.recentsDir, 'acct', 'org', `${obj.sessionId}.json`), obj);

const eLine = (uuid, ts, text) => JSON.stringify({ uuid, parentUuid: null, timestamp: ts, type: 'assistant', text });
const baseLines = (projectRoot) => [
  JSON.stringify({ type: 'user', cwd: projectRoot, sessionId: S }),
  eLine('u-base', 't1', 'shared base'),
];

/**
 * Vault holds S pushed from machine A. Machine B has its own local S.
 *  - localKind 'ahead':     B = vault content + one extra entry (fast-forward)
 *  - localKind 'diverged':  A pushed base+extraA; B has base+extraB (true merge)
 *  - localKind 'unrelated': B's S shares nothing with the vault copy (conflict)
 */
function setup({ vaultLast = 200, localLast = 100, localKind = 'ahead', cleanIncoming = false } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-merge-vault-'));
  tmps.push(vault);
  initVault(vault);

  const A = makeMachine('A');
  const B = makeMachine('B');
  const cfgA = { vaultDir: vault, machineId: 'mA', machineName: 'A', projects: [] };
  const projA = { id: PROJ, name: 'P', localPath: A.projectRoot, gitRemote: '' };

  const aLines = [...baseLines(A.projectRoot), ...(localKind === 'diverged' ? [eLine('u-fromA', 't3', 'EXTRA from A')] : [])];
  writeText(tFile(A, A.projectRoot, S), aLines.join('\n'));
  recents(A, { sessionId: 'la_S', cliSessionId: S, title: 'S', lastActivityAt: vaultLast, cwd: A.projectRoot, transcriptUnavailable: true });
  pushProject(cfgA, projA, A.paths);

  if (cleanIncoming) {
    writeText(tFile(A, A.projectRoot, T), JSON.stringify({ type: 'user', cwd: A.projectRoot, sessionId: T }));
    recents(A, { sessionId: 'la_T', cliSessionId: T, title: 'T', lastActivityAt: vaultLast, cwd: A.projectRoot, transcriptUnavailable: true });
    pushProject(cfgA, projA, A.paths);
  }

  let bLines;
  if (localKind === 'unrelated') bLines = [JSON.stringify({ totally: 'different' }), eLine('u-alien', 't1', 'no overlap')];
  else if (localKind === 'diverged') bLines = [...baseLines(B.projectRoot), eLine('u-fromB', 't4', 'EXTRA from B')];
  else bLines = [...baseLines(B.projectRoot), eLine('u-extraB', 't5', 'EXTRA edit made only on B')];
  const bText = bLines.join('\n');
  writeText(tFile(B, B.projectRoot, S), bText);
  recents(B, { sessionId: 'lb_S', cliSessionId: S, title: 'S', lastActivityAt: localLast, cwd: B.projectRoot, transcriptUnavailable: true });

  const projB = { id: PROJ, name: 'P', localPath: B.projectRoot, gitRemote: '' };
  return { vault, A, B, projB, bText };
}

const cfgB = (vault, projB, settings = {}) => ({ vaultDir: vault, machineId: 'mB', machineName: 'B', projects: [projB], settings });

// ---------- lossless paths ----------

test('local ahead of vault: pull writes nothing; push UPDATES the vault copy', () => {
  const s = setup({ localKind: 'ahead' });
  const r = pullProject(cfgB(s.vault, s.projB), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.merged, []);
  assert.ok(r.skipped.includes(S), 'local superset: nothing to pull');
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bText, 'local untouched');

  const pr = pushProject(cfgB(s.vault, s.projB), s.projB, s.B.paths);
  assert.deepEqual(pr.updated, [S], 'continued session propagates to the vault');
  const v = readVaultSession(s.vault, PROJ, S);
  assert.ok(v.transcriptTokenized.includes('EXTRA edit made only on B'));
  assert.equal(v.meta.updatedByMachineId, 'mB');

  const pr2 = pushProject(cfgB(s.vault, s.projB), s.projB, s.B.paths);
  assert.deepEqual(pr2.updated, [], 'push is idempotent after the update');
});

test('true divergence, defaults: pull merges losslessly with an undo snapshot', () => {
  const s = setup({ localKind: 'diverged' });
  const r = pullProject(cfgB(s.vault, s.projB), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.merged, [S]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.forks, []);
  const text = readText(tFile(s.B, s.projB.localPath, S));
  assert.ok(text.includes('EXTRA from A') && text.includes('EXTRA from B'), 'both branches kept');
  assert.equal(undoFiles(s.B, s.projB.localPath).length, 1, 'undo snapshot written before overwrite');
});

test('divergence with autoMergeIfNoConflicts off: reported as available, nothing written', () => {
  const s = setup({ localKind: 'diverged' });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMergeIfNoConflicts: false }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.available.includes(S));
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bText, 'local untouched');
});

test('dry-run divergence: merge reported, nothing written', () => {
  const s = setup({ localKind: 'diverged' });
  const r = pullProject(cfgB(s.vault, s.projB), s.projB, s.B.paths, { dryRun: true });
  assert.deepEqual(r.merged, [S]);
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bText);
  assert.equal(undoFiles(s.B, s.projB.localPath).length, 0);
});

// ---------- true conflicts (unrelated content) ----------

test('unrelated content, autoMerge off: conflict reported, nothing written', () => {
  const s = setup({ localKind: 'unrelated' });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: false }), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.conflicts, [S]);
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bText, 'local untouched');
  assert.equal(fs.existsSync(forkFile(s.B, s.projB.localPath, S)), false);
});

test('unrelated content, autoMerge on, vault newer: vault wins, old local kept as .fork', () => {
  const s = setup({ localKind: 'unrelated', vaultLast: 300, localLast: 100 });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: true }), s.projB, s.B.paths, { dryRun: false });
  assert.equal(r.forks.length, 1);
  assert.equal(r.forks[0].winner, 'vault');
  assert.equal(readText(forkFile(s.B, s.projB.localPath, S)), s.bText, 'loser preserved as .fork');
});

test('push leaves an unrelated vault copy alone (pushConflicts)', () => {
  const s = setup({ localKind: 'unrelated' });
  const before = readVaultSession(s.vault, PROJ, S).transcriptTokenized;
  const pr = pushProject(cfgB(s.vault, s.projB), s.projB, s.B.paths);
  assert.deepEqual(pr.pushConflicts, [S]);
  assert.equal(readVaultSession(s.vault, PROJ, S).transcriptTokenized, before, 'vault untouched');
});

// ---------- clean incoming (unchanged from Phase 5) ----------

test('clean incoming still applies alongside other sessions (defaults)', () => {
  const s = setup({ localKind: 'ahead', cleanIncoming: true });
  const r = pullProject(cfgB(s.vault, s.projB), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.pulled.includes(T));
  assert.equal(fs.existsSync(tFile(s.B, s.projB.localPath, T)), true);
});

test('autoMergeIfNoConflicts off: clean incoming reported, not applied', () => {
  const s = setup({ localKind: 'ahead', cleanIncoming: true });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMergeIfNoConflicts: false }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.available.includes(T));
  assert.equal(fs.existsSync(tFile(s.B, s.projB.localPath, T)), false);
});

// ---------- status ----------

test('status counts a hash-diverged session in the conflicts column', () => {
  const s = setup({ localKind: 'diverged' });
  const [row] = status(cfgB(s.vault, s.projB), s.B.paths);
  assert.equal(row.conflicts, 1);
  assert.equal(row.local, 1);
  assert.equal(row.vault, 1);
});

// ---------- fresh-machine recents fallback ----------
test('fresh machine with no recents structure still gets a tile (recentsDirRel fallback)', () => {
  const s = setup({ localKind: 'ahead', cleanIncoming: true });
  const C = makeMachine('C'); // brand new: empty recents dir, no guid folders
  const projC = { id: PROJ, name: 'P', localPath: path.join(C.paths.home, 'RCP', 'Proj') };
  fs.mkdirSync(projC.localPath, { recursive: true });
  const cfgC = { vaultDir: s.vault, machineId: 'mC', machineName: 'C', projects: [projC], settings: {} };
  const r = pullProject(cfgC, projC, C.paths, { dryRun: false });
  assert.ok(r.pulled.length >= 1);
  assert.deepEqual(r.noRecents, [], 'no tile went missing');
  const guidDir = path.join(C.paths.recentsDir, 'acct', 'org');
  assert.ok(fs.existsSync(guidDir), 'acct/org structure recreated from vault meta');
  assert.ok(fs.readdirSync(guidDir).some((f) => f.endsWith('.json')), 'tile written');
});

// ---------- incomingPolicy: ff-only (apply only if unchanged here) ----------
test('ff-only: pure fast-forward from the vault is applied', () => {
  const s = setup({ localKind: 'diverged' });
  // Rewind B's local copy to the shared base — B has changed nothing itself.
  writeText(tFile(s.B, s.projB.localPath, S), baseLines(s.projB.localPath).join('\n'));
  const r = pullProject(cfgB(s.vault, s.projB, { incomingPolicy: 'ff-only' }), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.merged, [S], 'fast-forward applied');
  assert.ok(readText(tFile(s.B, s.projB.localPath, S)).includes('EXTRA from A'));
});

test('ff-only: true divergence is deferred, local untouched', () => {
  const s = setup({ localKind: 'diverged' }); // both sides have their own extra entry
  const r = pullProject(cfgB(s.vault, s.projB, { incomingPolicy: 'ff-only' }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.available.includes(S), 'deferred, not merged');
  assert.deepEqual(r.merged, []);
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bText, 'local untouched');
});

test('ff-only: brand-new incoming sessions still apply', () => {
  const s = setup({ localKind: 'ahead', cleanIncoming: true });
  const r = pullProject(cfgB(s.vault, s.projB, { incomingPolicy: 'ff-only' }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.pulled.includes(T), 'new session T applied (nothing local to protect)');
});

test('legacy autoMergeIfNoConflicts=false still maps to manual', () => {
  const s = setup({ localKind: 'diverged' });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMergeIfNoConflicts: false }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.available.includes(S));
  assert.deepEqual(r.merged, []);
});
