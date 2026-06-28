// adopt --root: on a fresh machine with no known projects to anchor off, an
// explicit scan root lets vault projects still match local folders by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptFromVault } from '../src/sync.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

function tmp(name) {
  const d = path.join(os.tmpdir(), `cs-${name}-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); }

test('adopt --root matches a folder under the explicit root on a fresh machine', () => {
  const vaultDir = tmp('vault');
  const projectsRoot = tmp('projectsRoot');
  const home = tmp('home');

  // vault has one project named "Foo" (no machine paths recorded)
  writeJson(path.join(vaultDir, 'projects', 'pid-foo', 'project.json'), { id: 'pid-foo', name: 'Foo', machines: {} });
  // a bare on-disk folder "Foo" exists only under the explicit root
  fs.mkdirSync(path.join(projectsRoot, 'Foo'), { recursive: true });

  // fresh machine: no linked projects, empty paths (no registration / recents)
  const cfg = { machineId: 'm1', machineName: 't', vaultDir, projects: [], settings: { ...DEFAULT_SETTINGS } };
  const paths = {
    home,
    claudeJson: path.join(home, '.claude.json'),       // does not exist -> {}
    transcriptsDir: path.join(home, '.claude', 'projects'),
    recentsDir: path.join(home, 'recents'),             // does not exist -> empty
  };

  // without a root: nothing to anchor, so unmatched
  const noRoot = adoptFromVault({ ...cfg, projects: [] }, paths, { persist: false });
  assert.deepEqual(noRoot.adopted, []);
  assert.deepEqual(noRoot.unmatched, ['Foo']);

  // with --root: matches Foo under the explicit root
  const withRoot = adoptFromVault({ ...cfg, projects: [] }, paths, { persist: false, root: projectsRoot });
  assert.equal(withRoot.adopted.length, 1);
  assert.equal(withRoot.adopted[0].name, 'Foo');
  assert.equal(path.basename(withRoot.adopted[0].localPath), 'Foo');
  assert.deepEqual(withRoot.unmatched, []);
});
