// Tests for the adopt fixes (BUG1 path-dedupe, BUG2 on-disk folder matching) and
// the reparse-safe filesystem scan. Uses {persist:false} so the real
// ~/.claude-sync/config.json is never touched; everything runs in temp dirs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initVault, ensureProject } from '../src/vault.js';
import { writeJson } from '../src/util.js';
import { adoptFromVault } from '../src/sync.js';

const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

// Build a temp vault with project records + a fake machine whose projects root
// holds real on-disk folders. `Anchor` is registered (anchors the scan root);
// `OnDisk` exists but is unregistered; `Dup` is referenced by TWO vault records.
function setup() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-adopt-vault-'));
  tmps.push(vault);
  initVault(vault);
  // origin machineId differs from the adopting machine, so machines[me] is absent
  // and adopt must fall back to name matching.
  for (const [id, name] of [['anchor', 'Anchor'], ['ondisk', 'OnDisk'], ['dup1', 'Dup'], ['dup2', 'Dup']]) {
    ensureProject(vault, { id, name, machineId: 'origin', localPath: `ORIGIN\\${name}` });
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-adopt-m-'));
  tmps.push(root);
  const home = path.join(root, 'home');
  const projectsRoot = path.join(home, 'RCP');
  for (const name of ['Anchor', 'OnDisk', 'Dup']) fs.mkdirSync(path.join(projectsRoot, name), { recursive: true });

  const paths = {
    platform: process.platform, home,
    appDataBase: path.join(root, 'appdata'),
    claudeJson: path.join(home, '.claude.json'),
    transcriptsDir: path.join(home, '.claude', 'projects'),
    recentsDir: path.join(root, 'appdata', 'claude-code-sessions'),
    cliDir: path.join(root, 'appdata', 'claude-code'),
  };
  // Register only Anchor, so discoverProjects yields it and the scan root = RCP.
  writeJson(paths.claudeJson, { projects: { [path.join(projectsRoot, 'Anchor')]: { hasTrustDialogAccepted: true } } });

  const cfg = { vaultDir: vault, machineId: 'me', machineName: 'Me', projects: [] };
  return { cfg, paths, projectsRoot };
}

test('BUG2: adopt matches a bare on-disk folder that was never registered', () => {
  const { cfg, paths, projectsRoot } = setup();
  const r = adoptFromVault(cfg, paths, { persist: false });
  const onDisk = r.adopted.find((a) => a.name === 'OnDisk');
  assert.ok(onDisk, 'OnDisk should be adopted via filesystem scan');
  assert.equal(onDisk.localPath, path.join(projectsRoot, 'OnDisk'));
  assert.ok(!r.unmatched.includes('OnDisk'));
});

test('BUG1: Dup adopted exactly once; second record reported duplicate', () => {
  const { cfg, paths } = setup();
  const r = adoptFromVault(cfg, paths, { persist: false });
  const dups = r.adopted.filter((a) => a.name === 'Dup');
  assert.equal(dups.length, 1, 'Dup linked exactly once');
  assert.ok(r.duplicates.includes('Dup'), 'second Dup record flagged as duplicate');
  // No two linked projects share a normalized local path.
  const norm = cfg.projects.map((p) => p.localPath.toLowerCase().replace(/[\\/]+/g, '/'));
  assert.equal(new Set(norm).size, norm.length, 'no duplicate local paths in config');
});

test('everything matchable is matched; nothing left unmatched here', () => {
  const { cfg, paths } = setup();
  const r = adoptFromVault(cfg, paths, { persist: false });
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual([...new Set(r.adopted.map((a) => a.name))].sort(), ['Anchor', 'Dup', 'OnDisk']);
});

test('persist:false leaves the real config untouched (no throw, returns result)', () => {
  const { cfg, paths } = setup();
  const before = cfg.projects.length;
  const r = adoptFromVault(cfg, paths, { persist: false });
  assert.equal(before, 0);
  assert.ok(r.adopted.length >= 3);
});
