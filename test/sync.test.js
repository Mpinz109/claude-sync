// End-to-end engine test with NO real Claude state: build two fake machine
// profiles (A, B) and a temp vault, then push from A and pull on B. Verifies the
// union-by-cliSessionId logic, cross-machine path remap, BOM-free writes, recents
// + registration materialization, and idempotency.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/platform.js';
import { hasBom, writeText, writeJson, readText } from '../src/util.js';
import { initVault } from '../src/vault.js';
import { tokenize, detokenize } from '../src/tokens.js';
import { pushProject, pullProject, status } from '../src/sync.js';

const CLI_ID = '11111111-2222-3333-4444-555555555555';
const PROJ_ID = 'proj-aaaa';
const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

// A fake "machine": its own home, transcripts dir, recents dir, .claude.json.
function makeMachine(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cs-${tag}-`));
  tmps.push(root);
  const home = path.join(root, 'home');
  const paths = {
    platform: process.platform,
    home,
    appDataBase: path.join(root, 'appdata'),
    claudeJson: path.join(home, '.claude.json'),
    transcriptsDir: path.join(home, '.claude', 'projects'),
    recentsDir: path.join(root, 'appdata', 'claude-code-sessions'),
    cliDir: path.join(root, 'appdata', 'claude-code'),
  };
  const projectRoot = path.join(home, 'Desktop', 'RCP', 'Reactor');
  fs.mkdirSync(projectRoot, { recursive: true });
  return { root, paths, projectRoot };
}

function setup() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vault-'));
  tmps.push(vault);
  initVault(vault);

  const A = makeMachine('A');
  const B = makeMachine('B');

  // Seed machine A with a transcript (paths are A's) + a recents tile.
  const original = [
    JSON.stringify({ type: 'user', sessionId: CLI_ID, cwd: A.projectRoot }),
    JSON.stringify({ type: 'assistant', file: A.projectRoot + '\\src\\x.py', home: A.paths.home + '\\.claude.json' }),
  ].join('\n');
  writeText(path.join(A.paths.transcriptsDir, encodeCwd(A.projectRoot), `${CLI_ID}.jsonl`), original);
  // A recents tile for that session.
  writeJson(path.join(A.paths.recentsDir, 'acct', 'org', 'local_a.json'), {
    sessionId: 'local_a', cliSessionId: CLI_ID, title: 'Reactor', model: 'claude-opus-4-8',
    createdAt: 1, lastActivityAt: 2, cwd: A.projectRoot, transcriptUnavailable: true,
  });
  // Machine B already has a recents guid folder (so writeLocalRecents has a home).
  writeJson(path.join(B.paths.recentsDir, 'acct', 'org', 'seed.json'), { sessionId: 'seed', note: 'pre-existing' });

  const cfgA = { vaultDir: vault, machineId: 'mA', machineName: 'Machine-A', projects: [] };
  const cfgB = { vaultDir: vault, machineId: 'mB', machineName: 'Machine-B', projects: [] };
  const projectA = { id: PROJ_ID, name: 'Reactor', localPath: A.projectRoot, gitRemote: '' };
  const projectB = { id: PROJ_ID, name: 'Reactor', localPath: B.projectRoot, gitRemote: '' };
  return { vault, A, B, cfgA, cfgB, projectA, projectB, original };
}

test('push: A -> vault publishes the session', () => {
  const { vault, A, cfgA, projectA } = setup();
  const r = pushProject(cfgA, projectA, A.paths);
  assert.deepEqual(r.pushed, [CLI_ID]);
  assert.deepEqual(r.skipped, []);
  // Vault stored a tokenized transcript (no A-specific path leaked).
  const stored = readText(path.join(vault, 'projects', PROJ_ID, 'sessions', CLI_ID, 'transcript.jsonl'));
  assert.ok(stored.includes('{{PROJECT_ROOT}}'));
  assert.ok(!stored.includes('cs-A-'), 'A temp path must not leak into vault');
});

test('push is idempotent (second push skips)', () => {
  const { A, cfgA, projectA } = setup();
  pushProject(cfgA, projectA, A.paths);
  const again = pushProject(cfgA, projectA, A.paths);
  assert.deepEqual(again.pushed, []);
  assert.deepEqual(again.skipped, [CLI_ID]);
});

test('status reflects published session (toPush 0 after push)', () => {
  const { A, cfgA, projectA } = setup();
  pushProject(cfgA, projectA, A.paths);
  const [row] = status({ ...cfgA, projects: [projectA] }, A.paths);
  assert.equal(row.local, 1);
  assert.equal(row.vault, 1);
  assert.equal(row.toPush, 0);
  assert.equal(row.toPull, 0);
});

test('pull dry-run on B detects the session without writing', () => {
  const { A, B, cfgA, cfgB, projectA, projectB } = setup();
  pushProject(cfgA, projectA, A.paths);
  const r = pullProject(cfgB, projectB, B.paths, { dryRun: true });
  assert.deepEqual(r.pulled, [CLI_ID]);
  assert.equal(fs.existsSync(path.join(B.paths.transcriptsDir, encodeCwd(projectB.localPath), `${CLI_ID}.jsonl`)), false);
});

test('real pull on B materializes transcript remapped to B paths, BOM-free', () => {
  const { A, B, cfgA, cfgB, projectA, projectB, original } = setup();
  pushProject(cfgA, projectA, A.paths);
  const r = pullProject(cfgB, projectB, B.paths, { dryRun: false });
  assert.deepEqual(r.pulled, [CLI_ID]);

  const outFile = path.join(B.paths.transcriptsDir, encodeCwd(projectB.localPath), `${CLI_ID}.jsonl`);
  const got = readText(outFile);
  // Same content as A's original but re-materialized with B's paths — exactly the
  // push(tokenize)+pull(detokenize) pipeline applied with each machine's context.
  const expected = detokenize(
    tokenize(original, { home: A.paths.home, projectRoot: A.projectRoot }),
    { home: B.paths.home, projectRoot: B.projectRoot },
  );
  assert.equal(got, expected);
  assert.ok(!got.includes('cs-A-'), 'no A-specific temp path leaks into B output');
  assert.equal(hasBom(outFile), false);

  // Recents tile written into B's existing guid folder with the unavailable flag cleared.
  const tile = path.join(B.paths.recentsDir, 'acct', 'org', 'local_a.json');
  assert.ok(fs.existsSync(tile));
  assert.equal(JSON.parse(readText(tile)).transcriptUnavailable, false);

  // Project registered in B's .claude.json.
  const reg = JSON.parse(readText(B.paths.claudeJson));
  assert.ok(reg.projects[projectB.localPath], 'project registered on B');
});

test('pull is idempotent (already-local session skipped)', () => {
  const { A, B, cfgA, cfgB, projectA, projectB } = setup();
  pushProject(cfgA, projectA, A.paths);
  pullProject(cfgB, projectB, B.paths, { dryRun: false });
  const again = pullProject(cfgB, projectB, B.paths, { dryRun: false });
  assert.deepEqual(again.pulled, []);
  assert.deepEqual(again.skipped, [CLI_ID]);
});
