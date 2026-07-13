// Per-project sync switch + primary/secondary machine roles. Same isolation
// pattern as the other suites: fake machine profiles + a temp vault, real
// config file never touched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/platform.js';
import { writeText, writeJson, readText } from '../src/util.js';
import { initVault, registerMachine, getPrimaryMachineId, listVaultSessions } from '../src/vault.js';
import { pushAll, pullProject, status } from '../src/sync.js';

const S = 'S1111111-0000-0000-0000-000000000000';
const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const mk = (pfx) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pfx)); tmps.push(d); return d; };

function makeMachine(tag) {
  const root = mk(`cs-pc-${tag}-`);
  const home = path.join(root, 'home');
  const paths = {
    platform: process.platform, home,
    appDataBase: path.join(root, 'appdata'),
    claudeJson: path.join(home, '.claude.json'),
    transcriptsDir: path.join(home, '.claude', 'projects'),
    recentsDir: path.join(root, 'appdata', 'claude-code-sessions'),
    cliDir: path.join(root, 'appdata', 'claude-code'),
  };
  return { root, paths };
}

function seedSession(m, projectRoot, id, { extra = '', last = 100, recentsId = 'r', unrelated = false } = {}) {
  fs.mkdirSync(projectRoot, { recursive: true });
  // v0.2: related divergence MERGES losslessly (treemerge), so the role/fork
  // tests below seed UNRELATED content (no shared lines or uuids) to reach the
  // true-conflict path that roles govern.
  const lines = (unrelated ? [
    JSON.stringify({ type: 'note', marker: 'no-overlap' + extra }),
    JSON.stringify({ type: 'assistant', text: 'unrelated' + extra }),
  ] : [
    JSON.stringify({ type: 'user', cwd: projectRoot, sessionId: id }),
    JSON.stringify({ type: 'assistant', text: 'base' + extra }),
  ]).join('\n');
  writeText(path.join(m.paths.transcriptsDir, encodeCwd(projectRoot), `${id}.jsonl`), lines);
  writeJson(path.join(m.paths.recentsDir, 'acct', 'org', `${recentsId}.json`),
    { sessionId: recentsId, cliSessionId: id, title: 'T', lastActivityAt: last, cwd: projectRoot, transcriptUnavailable: true });
  return lines;
}

// ---------- per-project sync switch ----------
test('pushAll skips syncEnabled:false projects; status flags them', () => {
  const vaultDir = mk('cs-pc-vault-');
  initVault(vaultDir);
  const A = makeMachine('A');
  const onRoot = path.join(A.paths.home, 'RCP', 'OnProj');
  const offRoot = path.join(A.paths.home, 'RCP', 'OffProj');
  seedSession(A, onRoot, S, { recentsId: 'on' });
  seedSession(A, offRoot, 'S2222222-0000-0000-0000-000000000000', { recentsId: 'off' });

  const cfg = {
    vaultDir, machineId: 'mA', machineName: 'A', settings: {},
    projects: [
      { id: 'P_on', name: 'OnProj', localPath: onRoot },                        // absent flag = enabled
      { id: 'P_off', name: 'OffProj', localPath: offRoot, syncEnabled: false }, // switched off
    ],
  };
  const results = pushAll(cfg, A.paths);
  assert.equal(results.length, 1, 'only the enabled project was pushed');
  assert.equal(results[0].project, 'OnProj');
  assert.equal(listVaultSessions(vaultDir, 'P_on').length, 1);
  assert.equal(listVaultSessions(vaultDir, 'P_off').length, 0, 'disabled project left the vault untouched');

  const rows = status(cfg, A.paths);
  const offRow = rows.find((r) => r.project === 'OffProj');
  assert.equal(offRow.enabled, false);
  assert.equal(rows.find((r) => r.project === 'OnProj').enabled, true);
});

// ---------- machine roles ----------
test('registerMachine records role; claiming primary demotes the old primary', () => {
  const vaultDir = mk('cs-pc-vault-');
  initVault(vaultDir);
  registerMachine(vaultDir, 'mA', 'A', 'primary');
  assert.equal(getPrimaryMachineId(vaultDir), 'mA');
  registerMachine(vaultDir, 'mB', 'B', 'primary'); // B takes over
  assert.equal(getPrimaryMachineId(vaultDir), 'mB');
  // mA was demoted, not deleted.
  const meta = JSON.parse(readText(path.join(vaultDir, 'vault.json')));
  assert.equal(meta.machines.mA.role, 'secondary');
});

// ---------- primary wins conflicts ----------
function conflictFixture({ primary }) {
  const vaultDir = mk('cs-pc-vault-');
  initVault(vaultDir);
  const A = makeMachine('A');
  const B = makeMachine('B');
  const rootA = path.join(A.paths.home, 'RCP', 'Proj');
  const rootB = path.join(B.paths.home, 'RCP', 'Proj');

  // A pushes the session into the vault (vault copy is NEWER by timestamp).
  seedSession(A, rootA, S, { last: 300, recentsId: 'ra' });
  const cfgA = { vaultDir, machineId: 'mA', machineName: 'A', settings: {}, projects: [{ id: 'P', name: 'Proj', localPath: rootA }] };
  pushAll(cfgA, A.paths);

  // B has an UNRELATED local copy (true conflict) that is OLDER by timestamp.
  const bLines = seedSession(B, rootB, S, { extra: ' + B-only edit', last: 100, recentsId: 'rb', unrelated: true });

  if (primary) registerMachine(vaultDir, primary, primary === 'mA' ? 'A' : 'B', 'primary');
  const cfgB = { vaultDir, machineId: 'mB', machineName: 'B', settings: { autoMerge: true }, projects: [{ id: 'P', name: 'Proj', localPath: rootB }] };
  const proj = cfgB.projects[0];
  return { vaultDir, B, rootB, bLines, cfgB, proj };
}
const tFile = (m, root) => path.join(m.paths.transcriptsDir, encodeCwd(root), `${S}.jsonl`);
const forkFile = (m, root) => path.join(m.paths.transcriptsDir, encodeCwd(root), `${S}.fork`);

test('no roles: newest wins (vault newer -> vault wins) — baseline unchanged', () => {
  const f = conflictFixture({ primary: null });
  const r = pullProject(f.cfgB, f.proj, f.B.paths, { dryRun: false });
  assert.equal(r.forks[0].winner, 'vault');
});

test('local machine is primary: local wins even though vault is newer', () => {
  const f = conflictFixture({ primary: 'mB' }); // B (the puller) is primary
  const r = pullProject(f.cfgB, f.proj, f.B.paths, { dryRun: false });
  assert.equal(r.forks[0].winner, 'local');
  assert.equal(readText(tFile(f.B, f.rootB)), f.bLines, 'primary keeps its own version');
  assert.equal(fs.existsSync(forkFile(f.B, f.rootB)), true, 'vault copy preserved as .fork');
});

test('incoming is from the primary: vault wins even if timestamps favored local', () => {
  // Make B's local copy NEWER, but A (the vault origin) is primary.
  const vaultDir = mk('cs-pc-vault-');
  initVault(vaultDir);
  const A = makeMachine('A');
  const B = makeMachine('B');
  const rootA = path.join(A.paths.home, 'RCP', 'Proj');
  const rootB = path.join(B.paths.home, 'RCP', 'Proj');
  seedSession(A, rootA, S, { last: 100, recentsId: 'ra' }); // vault copy older
  const cfgA = { vaultDir, machineId: 'mA', machineName: 'A', settings: {}, projects: [{ id: 'P', name: 'Proj', localPath: rootA }] };
  pushAll(cfgA, A.paths);
  const bLines = seedSession(B, rootB, S, { extra: ' + newer B edit', last: 900, recentsId: 'rb', unrelated: true }); // local newer, unrelated
  registerMachine(vaultDir, 'mA', 'A', 'primary');

  const cfgB = { vaultDir, machineId: 'mB', machineName: 'B', settings: { autoMerge: true }, projects: [{ id: 'P', name: 'Proj', localPath: rootB }] };
  const r = pullProject(cfgB, cfgB.projects[0], B.paths, { dryRun: false });
  assert.equal(r.forks[0].winner, 'vault', 'primary version wins regardless of timestamp');
  assert.equal(readText(forkFile(B, rootB)), bLines, 'B\'s newer edit preserved as .fork (never destroyed)');
});

// ---------- device removal ----------
test('removeDeviceFrom: matches by id or name (case-insensitive), null when absent', async () => {
  const { removeDeviceFrom } = await import('../src/config.js');
  const cfg = { devices: [
    { name: 'Old Laptop', syncthingId: 'AAAA-BBBB' },
    { name: 'Desktop', syncthingId: 'CCCC-DDDD' },
  ] };
  assert.equal(removeDeviceFrom(cfg, 'old laptop').syncthingId, 'AAAA-BBBB');
  assert.equal(cfg.devices.length, 1, 'removed from the list');
  assert.equal(removeDeviceFrom(cfg, 'CCCC-DDDD').name, 'Desktop');
  assert.equal(removeDeviceFrom(cfg, 'ghost'), null);
  assert.deepEqual(cfg.devices, []);
});

// ---------- identity reset ----------
test('syncthing resetIdentity wipes the managed home', async () => {
  const { Syncthing } = await import('../src/syncthing.js');
  const home = mk('cs-st-home-');
  fs.writeFileSync(path.join(home, 'cert.pem'), 'x');
  fs.writeFileSync(path.join(home, 'key.pem'), 'x');
  fs.writeFileSync(path.join(home, 'config.xml'), '<x/>');
  const st = new Syncthing({ home, binPath: 'unused' });
  st.resetIdentity();
  assert.equal(fs.existsSync(home), false, 'identity + config wiped; next start regenerates');
});
