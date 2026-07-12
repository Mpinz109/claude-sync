// Duplicate-project fixes: normalized discovery (the GUI "shows up in both
// Detected and Linked" bug), registration tidy, and vault record dedupe.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, readJson } from '../src/util.js';
import { initVault, ensureProject, writeVaultSession, listVaultSessions } from '../src/vault.js';
import { discoverProjects } from '../src/sync.js';
import { tidyRegistration, dedupeVault } from '../src/maintain.js';

const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const mk = (pfx) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pfx)); tmps.push(d); return d; };

function makeMachine() {
  const root = mk('cs-mt-');
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
// A spelling of the same path that differs as a raw string but normalizes
// equal. On Windows the real-world variant is forward slashes; on POSIX,
// path.join already emits forward slashes (a slash swap is a no-op there and
// the tests would assert nothing — exactly the gap Linux CI caught), so use a
// trailing slash instead.
const fwd = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : `${p}/`);

// ---------- the GUI bug: linked project re-detected via slash variant ----------
test('discoverProjects: slash variant of a LINKED path is not re-detected', () => {
  const m = makeMachine();
  const proj = path.join(m.paths.home, 'RCP', 'Anti-vibe Handlebar');
  fs.mkdirSync(proj, { recursive: true });
  // Registration holds the forward-slash spelling; the link uses backslashes.
  writeJson(m.paths.claudeJson, { projects: { [fwd(proj)]: {} } });
  const cfg = { projects: [{ id: 'P', name: 'Anti-vibe Handlebar', localPath: proj }] };
  const found = discoverProjects(m.paths, cfg);
  assert.equal(found.length, 0, 'variant of a linked path must not appear as unlinked');
});

test('discoverProjects: two registration spellings of one folder yield ONE candidate', () => {
  const m = makeMachine();
  const proj = path.join(m.paths.home, 'RCP', 'Solo');
  fs.mkdirSync(proj, { recursive: true });
  writeJson(m.paths.claudeJson, { projects: { [proj]: {}, [fwd(proj)]: {} } });
  const found = discoverProjects(m.paths, { projects: [] });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'Solo');
});

// ---------- registration tidy ----------
test('tidyRegistration: removes dead keys, merges variants, rekeys to linked spelling', () => {
  const m = makeMachine();
  const live = path.join(m.paths.home, 'RCP', 'Live');
  fs.mkdirSync(live, { recursive: true });
  const dead = path.join(m.paths.home, 'GONE', 'Old');
  writeJson(m.paths.claudeJson, {
    projects: {
      [dead]: { fromDead: true },
      [fwd(live)]: { hasTrustDialogAccepted: true }, // variant spelling of the linked path
    },
  });
  const cfg = { projects: [{ id: 'P', name: 'Live', localPath: live }] };

  // Dry run reports, does not write.
  const dry = tidyRegistration(m.paths, { apply: false, cfg });
  assert.deepEqual(dry.removed, [dead]);
  assert.equal(dry.rekeyed.length, 1);
  assert.ok(readJson(m.paths.claudeJson).projects[dead], 'dry run leaves the file alone');

  // Apply: dead gone, variant rekeyed to the linked backslash spelling.
  const r = tidyRegistration(m.paths, { apply: true, cfg });
  const reg = readJson(m.paths.claudeJson).projects;
  assert.equal(reg[dead], undefined);
  assert.equal(reg[fwd(live)], undefined, 'variant spelling removed');
  assert.ok(reg[live], 'linked spelling is now the key');
  assert.equal(reg[live].hasTrustDialogAccepted, true, 'flags carried over');
  assert.equal(r.kept, 1);

  // Idempotent.
  const again = tidyRegistration(m.paths, { apply: true, cfg });
  assert.deepEqual([again.removed.length, again.merged.length, again.rekeyed.length], [0, 0, 0]);
});

// ---------- vault dedupe ----------
function seedVaultDup() {
  const vaultDir = mk('cs-mt-vault-');
  initVault(vaultDir);
  // Two records, same name. The LINKED one holds S1; the dup holds S2.
  ensureProject(vaultDir, { id: 'canon', name: 'Anti-vibe Handlebar', machineId: 'mA', localPath: 'X:\\a' });
  ensureProject(vaultDir, { id: 'dup', name: 'Anti-vibe Handlebar', machineId: 'mOld', localPath: 'X:\\old' });
  writeVaultSession(vaultDir, 'canon', { cliSessionId: 'S1', transcriptTokenized: '{"x":1}', recentsTokenized: null, meta: { cliSessionId: 'S1' } });
  writeVaultSession(vaultDir, 'dup', { cliSessionId: 'S2', transcriptTokenized: '{"x":2}', recentsTokenized: null, meta: { cliSessionId: 'S2' } });
  const cfg = { vaultDir, projects: [{ id: 'canon', name: 'Anti-vibe Handlebar', localPath: 'X:\\a' }] };
  return { vaultDir, cfg };
}

test('dedupeVault: merges sessions into the linked record and retires the duplicate', () => {
  const { vaultDir, cfg } = seedVaultDup();

  const dry = dedupeVault(cfg, { apply: false });
  assert.equal(dry.merged.length, 1);
  assert.equal(listVaultSessions(vaultDir, 'dup').length, 1, 'dry run moves nothing');

  const r = dedupeVault(cfg, { apply: true });
  assert.equal(r.merged[0].canonical, 'canon', 'linked record chosen as canonical');
  assert.deepEqual(r.merged[0].moved, ['S2']);
  const ids = listVaultSessions(vaultDir, 'canon').map((s) => s.cliSessionId).sort();
  assert.deepEqual(ids, ['S1', 'S2'], 'canonical now holds both sessions');
  assert.equal(fs.existsSync(path.join(vaultDir, 'projects', 'dup', 'project.json')), false, 'dup retired');
  assert.ok(readJson(path.join(vaultDir, 'projects', 'dup', 'merged.json')).mergedInto === 'canon');

  // Idempotent: retired record is invisible to a second pass.
  const again = dedupeVault(cfg, { apply: true });
  assert.equal(again.merged.length, 0);
});

test('dedupeVault: same session id in both records is left in place and reported', () => {
  const { vaultDir, cfg } = seedVaultDup();
  // Both records also hold a DIVERGENT copy of the same session id.
  writeVaultSession(vaultDir, 'canon', { cliSessionId: 'SX', transcriptTokenized: '{"v":"canon"}', recentsTokenized: null, meta: {} });
  writeVaultSession(vaultDir, 'dup', { cliSessionId: 'SX', transcriptTokenized: '{"v":"dup"}', recentsTokenized: null, meta: {} });
  const r = dedupeVault(cfg, { apply: true });
  assert.equal(r.conflictsLeft.length, 1);
  assert.equal(r.conflictsLeft[0].cliSessionId, 'SX');
  // The canonical copy was not clobbered.
  const canonCopy = fs.readFileSync(path.join(vaultDir, 'projects', 'canon', 'sessions', 'SX', 'transcript.jsonl'), 'utf8');
  assert.match(canonCopy, /canon/);
});
