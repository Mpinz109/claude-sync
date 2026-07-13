// Phase 6: the per-OS schedule builders are pure, so we pin their output exactly.
// apply()/status()/remove() shell out and are not unit-tested here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, buildCommandArgs, windowsTaskXml, launchdPlist, cronLine,
  planInstall, TASK_NAME, LAUNCHD_LABEL, CRON_TAG,
} from '../src/schedule.js';

const NODE = 'C:\\node\\node.exe';
const CLI = 'C:\\app\\bin\\claude-sync.js';
const opt = { time: '03:00', node: NODE, cliPath: CLI };

test('parseTime parses and validates', () => {
  assert.deepEqual(parseTime('03:00'), { hour: 3, minute: 0 });
  assert.deepEqual(parseTime('23:59'), { hour: 23, minute: 59 });
  assert.throws(() => parseTime('crap'));
  assert.throws(() => parseTime('24:00'));
  assert.throws(() => parseTime('10:99'));
});

test('buildCommandArgs is push-only by default', () => {
  assert.deepEqual(buildCommandArgs({ node: NODE, cliPath: CLI }), [NODE, CLI, 'push']);
});

test('windowsTaskXml: run-if-missed + wake + correct time and command', () => {
  const xml = windowsTaskXml(opt);
  assert.match(xml, /<StartBoundary>2020-01-01T03:00:00<\/StartBoundary>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/); // run if missed
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/);
  assert.match(xml, /<DaysInterval>1<\/DaysInterval>/);
  assert.ok(xml.includes(`<Command>${NODE}</Command>`));
  assert.ok(xml.includes(`<Arguments>"${CLI}" push</Arguments>`));
});

test('launchdPlist: calendar interval + program args', () => {
  const plist = launchdPlist(opt);
  assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>Hour<\/key><integer>3<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.ok(plist.includes(`<string>${NODE}</string>`));
  assert.ok(plist.includes('<string>push</string>'));
});

test('cronLine: minute hour * * * quoted command + tag', () => {
  assert.equal(cronLine(opt), `0 3 * * * "${NODE}" "${CLI}" push ${CRON_TAG}`);
  assert.equal(cronLine({ time: '23:05', node: NODE, cliPath: CLI }), `5 23 * * * "${NODE}" "${CLI}" push ${CRON_TAG}`);
});

test('planInstall win32', () => {
  const p = planInstall({ scheduleAt: '03:00' }, { platform: 'win32', node: NODE, cliPath: CLI });
  assert.equal(p.platform, 'win32');
  assert.equal(p.tool, 'schtasks');
  assert.equal(p.taskName, TASK_NAME);
  assert.ok(p.xml.includes('<WakeToRun>true</WakeToRun>'));
  assert.deepEqual(p.createArgs('X.xml'), ['/Create', '/TN', TASK_NAME, '/XML', 'X.xml', '/F']);
});

test('planInstall darwin', () => {
  const p = planInstall({ scheduleAt: '03:00' }, { platform: 'darwin', node: NODE, cliPath: CLI, home: '/Users/me' });
  assert.equal(p.tool, 'launchctl');
  assert.equal(p.label, LAUNCHD_LABEL);
  assert.ok(p.plistPath.replace(/\\/g, '/').endsWith(`LaunchAgents/${LAUNCHD_LABEL}.plist`));
  assert.match(p.plist, /<key>Hour<\/key><integer>3<\/integer>/);
});

test('planInstall linux', () => {
  const p = planInstall({ scheduleAt: '03:00' }, { platform: 'linux', node: NODE, cliPath: CLI });
  assert.equal(p.tool, 'crontab');
  assert.equal(p.tag, CRON_TAG);
  assert.equal(p.line, `0 3 * * * "${NODE}" "${CLI}" push ${CRON_TAG}`);
});

test('planInstall defaults to 03:00 when scheduleAt unset', () => {
  const p = planInstall({}, { platform: 'linux', node: NODE, cliPath: CLI });
  assert.ok(p.line.startsWith('0 3 * * *'));
});

// ---------- packaged-app mode (ELECTRON_RUN_AS_NODE) ----------
test('runAsNode windows: wraps in cmd with ELECTRON_RUN_AS_NODE (XML-escaped)', () => {
  const xml = windowsTaskXml({ ...opt, runAsNode: true });
  assert.ok(xml.includes('<Command>cmd.exe</Command>'));
  assert.ok(xml.includes('set ELECTRON_RUN_AS_NODE=1&amp;&amp;'));
  assert.ok(xml.includes(`"${NODE}" "${CLI}" push`));
});

test('runAsNode launchd: EnvironmentVariables dict present', () => {
  const plist = launchdPlist({ ...opt, runAsNode: true });
  assert.ok(plist.includes('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>'));
  assert.ok(!launchdPlist(opt).includes('ELECTRON_RUN_AS_NODE'), 'absent without runAsNode');
});

test('runAsNode cron: env prefix on the line', () => {
  assert.ok(cronLine({ ...opt, runAsNode: true }).startsWith('0 3 * * * ELECTRON_RUN_AS_NODE=1 '));
});

// ---------- syncMode-aware scheduled command ----------
test('planInstall: mode push schedules bare push; richer modes schedule sync --unattended', () => {
  const winPush = planInstall({ scheduleAt: '03:00', syncMode: 'push' }, { platform: 'win32', node: NODE, cliPath: CLI, runAsNode: false });
  assert.ok(winPush.xml.includes(`"${CLI}" push`));
  const winFull = planInstall({ scheduleAt: '03:00', syncMode: 'full' }, { platform: 'win32', node: NODE, cliPath: CLI, runAsNode: false });
  assert.ok(winFull.xml.includes(`"${CLI}" sync --unattended`));
  assert.equal(winFull.mode, 'full');
  const cronCloud = planInstall({ scheduleAt: '03:00', syncMode: 'push-cloud' }, { platform: 'linux', node: NODE, cliPath: CLI, runAsNode: false });
  assert.ok(cronCloud.line.includes(`"${CLI}" sync --unattended`));
  const macFull = planInstall({ scheduleAt: '03:00', syncMode: 'full' }, { platform: 'darwin', node: NODE, cliPath: CLI, runAsNode: false });
  assert.ok(macFull.plist.includes('<string>sync</string>'));
  assert.ok(macFull.plist.includes('<string>--unattended</string>'));
});

test('planInstall: pull mode also schedules sync --unattended', () => {
  const p = planInstall({ scheduleAt: '03:00', syncMode: 'pull' }, { platform: 'win32', node: NODE, cliPath: CLI, runAsNode: false });
  assert.ok(p.xml.includes(`"${CLI}" sync --unattended`));
});
