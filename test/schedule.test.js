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
