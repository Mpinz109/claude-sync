// Phase 5: conflict detection + resolution. A conflict = same cliSessionId on
// both sides with divergent content. These tests pin every settings path with no
// real Claude state (temp machine profiles + temp vault).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/platform.js';
import { writeText, writeJson, readText } from '../src/util.js';
import { initVault } from '../src/vault.js';
import { tokenize, detokenize } from '../src/tokens.js';
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
const recents = (m, obj) => writeJson(path.join(m.paths.recentsDir, 'acct', 'org', `${obj.sessionId}.json`), obj);

// Build: vault holds session S pushed from A; machine B has a DIVERGENT local S.
function setup({ vaultLast = 200, localLast = 100, cleanIncoming = false } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-merge-vault-'));
  tmps.push(vault);
  initVault(vault);

  const A = makeMachine('A');
  const B = makeMachine('B');
  const cfgA = { vaultDir: vault, machineId: 'mA', machineName: 'A', projects: [] };
  const projA = { id: PROJ, name: 'P', localPath: A.projectRoot, gitRemote: '' };

  const aLines = [
    JSON.stringify({ type: 'user', cwd: A.projectRoot, sessionId: S }),
    JSON.stringify({ type: 'assistant', text: 'shared base' }),
  ].join('\n');
  writeText(tFile(A, A.projectRoot, S), aLines);
  recents(A, { sessionId: 'la_S', cliSessionId: S, title: 'S', lastActivityAt: vaultLast, cwd: A.projectRoot, transcriptUnavailable: true });
  pushProject(cfgA, projA, A.paths);

  if (cleanIncoming) {
    const tLines = JSON.stringify({ type: 'user', cwd: A.projectRoot, sessionId: T });
    writeText(tFile(A, A.projectRoot, T), tLines);
    recents(A, { sessionId: 'la_T', cliSessionId: T, title: 'T', lastActivityAt: vaultLast, cwd: A.projectRoot, transcriptUnavailable: true });
    pushProject(cfgA, projA, A.paths); // S skipped, T pushed
  }

  // B's divergent local S (an extra line) + its own recents tile.
  const bLines = [
    JSON.stringify({ type: 'user', cwd: B.projectRoot, sessionId: S }),
    JSON.stringify({ type: 'assistant', text: 'shared base' }),
    JSON.stringify({ type: 'assistant', text: 'EXTRA edit made only on B' }),
  ].join('\n');
  writeText(tFile(B, B.projectRoot, S), bLines);
  recents(B, { sessionId: 'lb_S', cliSessionId: S, title: 'S', lastActivityAt: localLast, cwd: B.projectRoot, transcriptUnavailable: true });

  const projB = { id: PROJ, name: 'P', localPath: B.projectRoot, gitRemote: '' };
  // What A's session looks like once re-materialized on B (vault content, B paths):
  const vaultOnB = detokenize(
    tokenize(aLines, { home: A.paths.home, projectRoot: A.projectRoot }),
    { home: B.paths.home, projectRoot: B.projectRoot },
  );
  return { vault, A, B, projB, bLines, vaultOnB };
}

const cfgB = (vault, projB, settings) => ({ vaultDir: vault, machineId: 'mB', machineName: 'B', projects: [projB], settings });

test('autoMerge off: conflict reported, nothing written', () => {
  const s = setup();
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: false, autoMergeIfNoConflicts: true }), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.conflicts, [S]);
  assert.deepEqual(r.pulled, []);
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bLines, 'local untouched');
  assert.equal(fs.existsSync(forkFile(s.B, s.projB.localPath, S)), false, 'no fork written');
});

test('autoMerge on, vault newer: vault wins, old local kept as .fork', () => {
  const s = setup({ vaultLast: 300, localLast: 100 });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: true }), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.pulled, [S]);
  assert.equal(r.forks.length, 1);
  assert.equal(r.forks[0].winner, 'vault');
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.vaultOnB, 'live transcript is now the vault version');
  assert.equal(readText(forkFile(s.B, s.projB.localPath, S)), s.bLines, 'loser (old local) preserved as .fork');
});

test('autoMerge on, local newer: local wins, vault copy kept as .fork', () => {
  const s = setup({ vaultLast: 100, localLast: 300 });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: true }), s.projB, s.B.paths, { dryRun: false });
  assert.deepEqual(r.pulled, []);
  assert.equal(r.forks[0].winner, 'local');
  assert.equal(readText(tFile(s.B, s.projB.localPath, S)), s.bLines, 'local kept');
  assert.equal(readText(forkFile(s.B, s.projB.localPath, S)), s.vaultOnB, 'loser (vault copy) preserved as .fork');
});

test('status reports the conflict count', () => {
  const s = setup();
  const [row] = status(cfgB(s.vault, s.projB, {}), s.B.paths);
  assert.equal(row.conflicts, 1);
  assert.equal(row.local, 1);
  assert.equal(row.vault, 1);
  assert.equal(row.toPush, 0);
  assert.equal(row.toPull, 0);
});

test('clean incoming is applied alongside an unresolved conflict (defaults)', () => {
  const s = setup({ cleanIncoming: true });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: false, autoMergeIfNoConflicts: true }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.pulled.includes(T), 'new session T pulled');
  assert.deepEqual(r.conflicts, [S], 'S still a conflict');
  assert.equal(fs.existsSync(tFile(s.B, s.projB.localPath, T)), true);
});

test('autoMergeIfNoConflicts off: clean incoming is reported, not applied', () => {
  const s = setup({ cleanIncoming: true });
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: false, autoMergeIfNoConflicts: false }), s.projB, s.B.paths, { dryRun: false });
  assert.ok(r.available.includes(T));
  assert.ok(!r.pulled.includes(T));
  assert.equal(fs.existsSync(tFile(s.B, s.projB.localPath, T)), false);
});

test('dry-run flags the conflict without writing anything', () => {
  const s = setup();
  const r = pullProject(cfgB(s.vault, s.projB, { autoMerge: true }), s.projB, s.B.paths, { dryRun: true });
  assert.deepEqual(r.conflicts, [S]);
  assert.equal(fs.existsSync(forkFile(s.B, s.projB.localPath, S)), false);
});
