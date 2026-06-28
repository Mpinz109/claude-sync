// encodeCwd must reproduce Claude Code's transcript-folder naming exactly, or
// pull writes to the wrong folder and the tiles never appear. resolvePaths is
// checked for shape + override behavior (OS-specific detection isn't asserted
// here since it depends on the host).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { encodeCwd, resolvePaths } from '../src/platform.js';

test('encodeCwd: Windows path -> dashed folder name (matches Claude)', () => {
  assert.equal(
    encodeCwd('C:\\Users\\mpinz\\OneDrive\\Desktop\\Random Claude Projects\\Chrynobl investigation'),
    'C--Users-mpinz-OneDrive-Desktop-Random-Claude-Projects-Chrynobl-investigation',
  );
});

test('encodeCwd: POSIX path', () => {
  assert.equal(encodeCwd('/home/max/proj a'), '-home-max-proj-a');
});

test('encodeCwd: every non-alphanumeric becomes a dash; alnum preserved', () => {
  const out = encodeCwd('Ab9 _.\\/:-x');
  assert.match(out, /^[A-Za-z0-9-]+$/);
  assert.equal(out, 'Ab9-------x');
});

test('encodeCwd: idempotent on an already-encoded name', () => {
  const once = encodeCwd('C:\\Users\\a b');
  assert.equal(encodeCwd(once), once, 'dashes and alnum survive a second pass');
});

test('resolvePaths returns the expected keys', () => {
  const p = resolvePaths();
  for (const k of ['platform', 'home', 'appDataBase', 'claudeJson', 'transcriptsDir', 'recentsDir', 'cliDir']) {
    assert.ok(k in p, `missing ${k}`);
  }
  assert.ok(p.transcriptsDir.endsWith(path.join('.claude', 'projects')));
  assert.ok(p.claudeJson.endsWith('.claude.json'));
});

test('resolvePaths applies overrides', () => {
  const p = resolvePaths({ vaultDir: 'X:\\vault', home: '/custom' });
  assert.equal(p.vaultDir, 'X:\\vault');
  assert.equal(p.home, '/custom');
});
