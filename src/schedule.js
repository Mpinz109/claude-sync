// Phase 6: a daily background job that runs `claude-sync push` (push-only is safe
// unattended — it never writes Claude state). Per-OS:
//   win32  -> Task Scheduler via schtasks /Create /XML (StartWhenAvailable =
//             run-if-missed, WakeToRun = wake the machine)
//   darwin -> launchd LaunchAgent plist with StartCalendarInterval
//   linux  -> a single crontab line tagged for safe add/remove
//
// The builders below are PURE (no IO, no shelling out) so they can be unit-tested
// per OS by passing an explicit platform; apply()/status()/remove() execute them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const TASK_NAME = 'claude-sync-daily';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the CLI entrypoint (used as the scheduled command). */
export function defaultCliPath() {
  return path.join(HERE, '..', 'bin', 'claude-sync.js');
}

/** '03:00' -> { hour: 3, minute: 0 }. Throws on a malformed time. */
export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) throw new Error(`bad scheduleAt time: ${hhmm} (want HH:MM)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time out of range: ${hhmm}`);
  return { hour, minute };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** The command to run: [node, cliPath, 'push']. push-only is unattended-safe. */
export function buildCommandArgs({ node = process.execPath, cliPath = defaultCliPath(), sub = 'push' } = {}) {
  return [node, cliPath, sub];
}

// ---------- Windows: Task Scheduler XML ----------
export function windowsTaskXml({ time, node = process.execPath, cliPath = defaultCliPath() }) {
  const { hour, minute } = parseTime(time);
  const start = `2020-01-01T${pad2(hour)}:${pad2(minute)}:00`;
  // Command = the node exe; Arguments = the quoted script path + subcommand.
  const command = node;
  const args = `"${cliPath}" push`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>claude-sync daily push</Description></RegistrationInfo>',
    '  <Triggers><CalendarTrigger>',
    `    <StartBoundary>${start}</StartBoundary>`,
    '    <Enabled>true</Enabled>',
    '    <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '  </CalendarTrigger></Triggers>',
    '  <Settings>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <WakeToRun>true</WakeToRun>',
    '    <Enabled>true</Enabled>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>${command}</Command><Arguments>${args}</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
  ].join('\n');
}

// ---------- macOS: launchd plist ----------
export const LAUNCHD_LABEL = 'com.claude-sync.daily';
export function launchdPlistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}
export function launchdPlist({ time, node = process.execPath, cliPath = defaultCliPath() }) {
  const { hour, minute } = parseTime(time);
  const progArgs = buildCommandArgs({ node, cliPath }).map((a) => `    <string>${a}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key><array>',
    progArgs,
    '  </array>',
    '  <key>StartCalendarInterval</key><dict>',
    `    <key>Hour</key><integer>${hour}</integer>`,
    `    <key>Minute</key><integer>${minute}</integer>`,
    '  </dict>',
    '  <key>RunAtLoad</key><false/>',
    '</dict></plist>',
  ].join('\n');
}

// ---------- Linux: crontab line ----------
export const CRON_TAG = '# claude-sync-daily';
export function cronLine({ time, node = process.execPath, cliPath = defaultCliPath() }) {
  const { hour, minute } = parseTime(time);
  return `${minute} ${hour} * * * "${node}" "${cliPath}" push ${CRON_TAG}`;
}

/**
 * Describe (without executing) what install would do on a platform. Pure —
 * everything apply() needs, so tests can assert per-OS artifacts.
 */
export function planInstall(settings = {}, { platform = process.platform, node, cliPath, home = os.homedir() } = {}) {
  const time = settings.scheduleAt || '03:00';
  if (platform === 'win32') {
    return { platform, tool: 'schtasks', taskName: TASK_NAME, time,
      xml: windowsTaskXml({ time, node, cliPath }),
      createArgs: (xmlPath) => ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'] };
  }
  if (platform === 'darwin') {
    return { platform, tool: 'launchctl', label: LAUNCHD_LABEL, time,
      plistPath: launchdPlistPath(home), plist: launchdPlist({ time, node, cliPath }) };
  }
  return { platform, tool: 'crontab', tag: CRON_TAG, time, line: cronLine({ time, node, cliPath }) };
}

// ---------- execution (not unit-tested; shells out) ----------
function sh(cmd, args, input) {
  return execFileSync(cmd, args, { input, encoding: 'utf8', windowsHide: true });
}

export function install(settings = {}, opts = {}) {
  const plan = planInstall(settings, opts);
  if (plan.platform === 'win32') {
    const xmlPath = path.join(os.tmpdir(), `${TASK_NAME}.xml`);
    fs.writeFileSync(xmlPath, plan.xml, 'utf8');
    sh('schtasks', plan.createArgs(xmlPath));
  } else if (plan.platform === 'darwin') {
    fs.mkdirSync(path.dirname(plan.plistPath), { recursive: true });
    fs.writeFileSync(plan.plistPath, plan.plist, 'utf8');
    try { sh('launchctl', ['unload', plan.plistPath]); } catch { /* not loaded */ }
    sh('launchctl', ['load', '-w', plan.plistPath]);
  } else {
    const current = currentCrontab();
    const without = stripTagged(current, CRON_TAG);
    sh('crontab', ['-'], `${[...without, plan.line].join('\n')}\n`);
  }
  return { installed: true, when: plan.time, platform: plan.platform };
}

export function remove(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    try { sh('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']); } catch { /* absent */ }
  } else if (platform === 'darwin') {
    const p = launchdPlistPath(opts.home);
    try { sh('launchctl', ['unload', p]); } catch { /* not loaded */ }
    try { fs.rmSync(p, { force: true }); } catch { /* absent */ }
  } else {
    const without = stripTagged(currentCrontab(), CRON_TAG);
    sh('crontab', ['-'], without.length ? `${without.join('\n')}\n` : '');
  }
  return { removed: true, platform };
}

export function status(opts = {}) {
  const platform = opts.platform || process.platform;
  try {
    if (platform === 'win32') {
      const out = sh('schtasks', ['/Query', '/TN', TASK_NAME]);
      return { installed: true, platform, detail: out.trim().split('\n').slice(-1)[0] };
    }
    if (platform === 'darwin') {
      const p = launchdPlistPath(opts.home);
      return { installed: fs.existsSync(p), platform, detail: p };
    }
    const found = currentCrontab().some((l) => l.includes(CRON_TAG));
    return { installed: found, platform };
  } catch {
    return { installed: false, platform };
  }
}

function currentCrontab() {
  try { return sh('crontab', ['-l']).split('\n').filter((l) => l.length); } catch { return []; }
}
function stripTagged(lines, tag) { return lines.filter((l) => !l.includes(tag)); }
