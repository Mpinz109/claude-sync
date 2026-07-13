// Sync-mode orchestrator (src/run.js): which steps run per mode, cloud
// integration through a fake S3, and the summary line. Temp machine profiles,
// no real Claude state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/platform.js';
import { writeText, writeJson } from '../src/util.js';
import { initVault } from '../src/vault.js';
import { runSync, summarizeRun, SYNC_MODES } from '../src/run.js';

const S = 'S0000000-0000-0000-0000-00000000RUN0';
const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const mk = (pfx) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pfx)); tmps.push(d); return d; };

class FakeS3 {
  constructor() { this.objects = new Map(); }
  async putObject(key, buf) { this.objects.set(key, Buffer.from(buf)); }
  async getObject(key) { return this.objects.has(key) ? Buffer.from(this.objects.get(key)) : null; }
  async listAll(prefix) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
}

function machine() {
  const root = mk('cs-run-');
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
  // one local session so push has something to publish
  writeText(path.join(paths.transcriptsDir, encodeCwd(projectRoot), `${S}.jsonl`),
    JSON.stringify({ type: 'user', cwd: projectRoot, sessionId: S }));
  writeJson(path.join(paths.recentsDir, 'acct', 'org', 'r1.json'),
    { sessionId: 'r1', cliSessionId: S, title: 'T', lastActivityAt: 5, cwd: projectRoot, transcriptUnavailable: true });
  const vaultDir = mk('cs-run-vault-');
  initVault(vaultDir);
  const cfg = {
    vaultDir, machineId: 'mR', machineName: 'R', settings: { syncMode: 'push' },
    projects: [{ id: 'P', name: 'Proj', localPath: projectRoot }],
  };
  return { cfg, paths, vaultDir };
}

const steps = (r) => r.steps.map((s) => s.step);

test('mode push: engine push only, no cloud steps', async () => {
  const { cfg, paths } = machine();
  const r = await runSync({ mode: 'push', cfg, paths, cloud: null });
  assert.deepEqual(steps(r), ['push']);
  assert.equal(r.steps[0].results[0].pushed.length, 1);
});

test('mode push-cloud: cloud pull, push, cloud push — vault lands in the bucket', async () => {
  const { cfg, paths } = machine();
  const s3 = new FakeS3();
  const cloud = { vaultDir: cfg.vaultDir, s3, prefix: 'vault/', passphrase: '' };
  const r = await runSync({ mode: 'push-cloud', cfg, paths, cloud });
  assert.deepEqual(steps(r), ['cloud-pull', 'push', 'cloud-push']);
  assert.ok(r.steps[2].uploaded.length > 0, 'session objects mirrored up');
  assert.ok([...s3.objects.keys()].some((k) => k.includes('transcript.jsonl')));
});

test('mode full: includes engine pull; force bypasses the Claude-running guard', async () => {
  const { cfg, paths } = machine();
  const r = await runSync({ mode: 'full', cfg, paths, cloud: null, force: true });
  assert.deepEqual(steps(r), ['pull', 'push']);
  assert.ok(Array.isArray(r.steps[0].results), 'pull ran (not skipped) under force');
});

test('mode full without cloud creds configured: cloud steps absent, rest proceeds', async () => {
  const { cfg, paths } = machine();
  cfg.settings.s3Bucket = ''; // cloud off
  const r = await runSync({ mode: 'full', cfg, paths, force: true });
  assert.ok(!steps(r).includes('cloud-pull'));
  assert.ok(steps(r).includes('push'));
});

test('unknown mode throws; all documented modes accepted', async () => {
  const { cfg, paths } = machine();
  await assert.rejects(() => runSync({ mode: 'yolo', cfg, paths, cloud: null }), /unknown sync mode/);
  for (const m of SYNC_MODES) assert.ok(m); // sanity: list exported
});

test('summarizeRun renders a one-liner with counts', async () => {
  const { cfg, paths } = machine();
  const r = await runSync({ mode: 'push', cfg, paths, cloud: null });
  const line = summarizeRun(r);
  assert.match(line, /^\[push\] pushed 1/);
});
