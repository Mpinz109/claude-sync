#!/usr/bin/env node
// claude-sync CLI — the engine, also usable directly. GUI calls the same src/*.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, findBundledCli, claudeRunning } from '../src/platform.js';
import { loadConfig, saveConfig, addProject, linkProjects, setSetting, setProjectSync } from '../src/config.js';
import { initVault, registerMachine } from '../src/vault.js';
import { pushAll, pullAll, adoptFromVault, discoverProjects, status as syncStatus } from '../src/sync.js';
import { gatherStatus } from '../src/status.js';
import * as schedule from '../src/schedule.js';
import * as gitsync from '../src/gitsync.js';
import { c, ok, warn, bad } from '../src/util.js';

const [, , cmd, ...args] = process.argv;

async function doctor() {
  const s = await gatherStatus();
  console.log(c.bold('\nclaude-sync doctor\n'));
  console.log(`${c.dim('platform')}      ${s.platform}`);
  console.log(`${c.dim('machine')}       ${s.machineName} ${c.dim(`(${s.machineId.slice(0, 8)})`)}${s.settings?.machineRole ? `  ${c.cyan(s.settings.machineRole)}` : ''}`);
  console.log(`${c.dim('app data')}      ${s.appDataBase}`);
  console.log(`${c.dim('vault')}         ${s.vaultDir || c.dim('(not set — run `claude-sync init`)')}`);
  console.log('');
  console.log(s.paths.registration.exists ? ok(`registration  ${s.paths.registration.path}`) : warn('registration  missing'));
  console.log(ok(`transcripts   ${s.paths.transcripts.projectFolders ?? 0} project folders`));
  console.log(ok(`recents       ${s.paths.recents.entries ?? 0} entries`));
  console.log(s.paths.cli.path ? ok(`bundled CLI   ${s.paths.cli.path}`) : warn('bundled CLI   not found'));
  console.log(s.claudeRunning ? warn('claude        RUNNING — close before pull') : ok('claude        not running'));
  console.log(`\n${c.dim('linked projects')} ${s.projects.length}   ${c.dim('paired devices')} ${s.devices.length}\n`);
}

function init() {
  const i = args.indexOf('--vault');
  const vaultDir = i >= 0 ? args[i + 1] : path.join(loadConfig().vaultDir || '', '');
  const cfg = loadConfig();
  const dir = i >= 0 ? args[i + 1] : cfg.vaultDir;
  if (!dir) { console.log(bad('usage: claude-sync init --vault <folder>')); return; }
  cfg.vaultDir = path.resolve(dir);
  saveConfig(cfg);
  initVault(cfg.vaultDir);
  console.log(ok(`vault initialized at ${cfg.vaultDir}`));
}

function link() {
  const [name, p] = args;
  if (!name || !p) { console.log(bad('usage: claude-sync link <name> <localPath>')); return; }
  const localPath = path.resolve(p);
  const id = addProject(name, localPath);
  console.log(ok(`linked "${name}" -> ${localPath} ${c.dim(`(${id.slice(0, 8)})`)}`));
}

function linkAll() {
  const d = discoverProjects();
  if (!d.length) { console.log(warn('no unlinked projects detected')); return; }
  const r = linkProjects(d);
  console.log(ok(`linked ${r.added} project(s); ${r.total} total`));
  for (const p of d) console.log(c.dim(`  + ${p.name}`));
}

function adopt() {
  const cfg = loadConfig();
  if (!cfg.vaultDir) { console.log(bad('no vault — run `claude-sync init --vault <folder>` first')); return; }
  const i = args.indexOf('--root');
  const root = i >= 0 ? path.resolve(args[i + 1]) : null;
  if (root) { setSetting('projectsRoot', root); console.log(c.dim(`scan root set to ${root}`)); }
  const r = adoptFromVault(undefined, undefined, { root });
  for (const a of r.adopted) console.log(ok(`adopted "${a.name}" -> ${a.localPath}`));
  if (r.already.length) console.log(c.dim(`already linked: ${r.already.join(', ')}`));
  if (r.duplicates?.length) console.log(warn(`skipped (same local folder already linked): ${r.duplicates.join(', ')}`));
  if (r.unmatched.length) console.log(warn(`no local folder found for: ${r.unmatched.join(', ')} (sync the files first, then re-run adopt)`));
}

function statusCmd() {
  const cfg = loadConfig();
  if (!cfg.vaultDir) { console.log(warn('no vault set — run `claude-sync init --vault <folder>`')); return; }
  const rows = syncStatus();
  if (!rows.length) { console.log(warn('no linked projects — run `claude-sync link <name> <path>`')); return; }
  console.log(c.bold('\nproject                         local  vault  →push  ←pull  ⚠conf'));
  for (const r of rows) {
    if (r.enabled === false) {
      console.log(c.dim(`${r.project.padEnd(30).slice(0, 30)}  (sync off)`));
      continue;
    }
    const conf = r.conflicts ? c.yellow(String(r.conflicts).padStart(5)) : String(r.conflicts ?? 0).padStart(5);
    console.log(`${r.project.padEnd(30).slice(0, 30)}  ${String(r.local).padStart(5)}  ${String(r.vault).padStart(5)}  ${String(r.toPush).padStart(5)}  ${String(r.toPull).padStart(5)}  ${conf}`);
  }
  console.log('');
}

function push() {
  const cfg = loadConfig();
  if (!cfg.vaultDir) { console.log(bad('no vault — run init first')); return; }
  const results = pushAll();
  for (const r of results) console.log(ok(`${r.project}: pushed ${r.pushed.length}, already there ${r.skipped.length}`));
}

async function pull() {
  const dryRun = !args.includes('--yes');
  const res = await pullAll(undefined, undefined, { dryRun, force: args.includes('--force') });
  if (res.blocked) { console.log(warn(res.reason)); return; }
  for (const r of res.results) {
    if (dryRun) {
      console.log(`${r.project}: ${r.pulled.length} would be pulled` + (r.conflicts.length ? warn(`, ${r.conflicts.length} conflict(s)`) : ''));
    } else {
      let line = `${r.project}: pulled ${r.pulled.length}, already local ${r.skipped.length}`;
      if (r.noRecents.length) line += c.dim(` (${r.noRecents.length} without a tile)`);
      console.log(ok(line));
      if (r.forks?.length) console.log(c.dim(`  resolved ${r.forks.length} conflict(s); loser kept as <id>.fork: ${r.forks.map((f) => f.cliSessionId.slice(0, 8)).join(', ')}`));
      if (r.conflicts?.length) console.log(warn(`  ${r.conflicts.length} unresolved conflict(s) (autoMerge off): ${r.conflicts.map((id) => id.slice(0, 8)).join(', ')}`));
      if (r.available?.length) console.log(c.dim(`  ${r.available.length} available, not applied (autoMergeIfNoConflicts off)`));
    }
  }
  if (dryRun) console.log(c.dim('\ndry run — re-run with `--yes` to apply (close Claude first).'));
}

function scheduleCmd() {
  const sub = args[0];
  const cfg = loadConfig();
  if (sub === 'install') {
    const r = schedule.install(cfg.settings || {});
    console.log(ok(`scheduled daily push at ${r.when} (${r.platform})`));
  } else if (sub === 'remove') {
    schedule.remove();
    console.log(ok('schedule removed'));
  } else if (sub === 'status' || !sub) {
    const s = schedule.status();
    console.log(s.installed ? ok(`scheduled (${s.platform})${s.detail ? c.dim(' — ' + s.detail) : ''}`) : warn('no schedule installed'));
  } else {
    console.log(bad('usage: claude-sync schedule install|status|remove'));
  }
}

function projectCmd() {
  const sub = args[0] || 'list';
  const cfg = loadConfig();
  if (sub === 'list') {
    if (!cfg.projects.length) { console.log(warn('no linked projects')); return; }
    for (const p of cfg.projects) {
      const state = p.syncEnabled !== false ? c.green('on ') : c.yellow('off');
      console.log(`  [${state}] ${p.name.padEnd(32).slice(0, 32)} ${c.dim(p.localPath)}`);
    }
    return;
  }
  if (sub === 'on' || sub === 'off') {
    const key = args.slice(1).join(' ');
    if (!key) { console.log(bad(`usage: claude-sync project ${sub} <name-or-path>`)); return; }
    const p = setProjectSync(key, sub === 'on');
    if (!p) { console.log(bad(`no linked project matches "${key}" (try \`claude-sync project list\`)`)); return; }
    console.log(ok(`sync ${sub} for "${p.name}"`));
    return;
  }
  console.log(bad('usage: claude-sync project [list] | project on <name> | project off <name>'));
}

function roleCmd() {
  const sub = args[0];
  const cfg = loadConfig();
  if (!sub) {
    const r = cfg.settings.machineRole;
    console.log(r ? `machine role: ${c.bold(r)}` : 'machine role: (none) — set with `claude-sync role primary|secondary`');
    return;
  }
  if (!['primary', 'secondary', 'clear'].includes(sub)) {
    console.log(bad('usage: claude-sync role [primary|secondary|clear]'));
    return;
  }
  const val = sub === 'clear' ? '' : sub;
  setSetting('machineRole', val);
  if (cfg.vaultDir && val) {
    registerMachine(cfg.vaultDir, cfg.machineId, cfg.machineName, val);
    console.log(ok(`this machine is now ${c.bold(val)}${val === 'primary' ? ' — the source of truth on conflicts (any other primary was demoted)' : ''}`));
  } else if (val) {
    console.log(ok(`role set to ${val} (no vault yet — it will register on the next push)`));
  } else {
    console.log(ok('role cleared'));
  }
}

function filesCmd() {
  const sub = args[0] || 'status';
  const cfg = loadConfig();
  if (!cfg.vaultDir) { console.log(bad('no vault — run init first')); return; }
  const fn = { status: gitsync.filesStatus, push: gitsync.publish, pull: gitsync.integrate }[sub];
  if (!fn) { console.log(bad('usage: claude-sync files status|push|pull')); return; }
  if (!cfg.projects.length) { console.log(warn('no linked projects')); return; }
  for (const p of cfg.projects) {
    try {
      const r = fn(cfg, p);
      if (r.mode === 'none') { console.log(c.dim(`${r.project}: not a git repo`)); continue; }
      if (sub === 'status') {
        console.log(`${r.project}: ${r.mode}${r.branch ? ` @${r.branch}` : ''}${r.mode === 'bundle' ? c.dim(` (${r.peerBundles} peer bundle(s))`) : ''}`);
      } else if (sub === 'push') {
        console.log(ok(`${r.project}: ${r.mode === 'remote' ? `pushed ${r.pushed}` : `bundled -> ${path.basename(r.bundle)}`}`));
      } else {
        const conf = (r.conflicts || []).length;
        const got = r.mode === 'remote' ? (r.fastForwarded ? 'fast-forwarded' : 'up to date / diverged') : `integrated ${r.integrated.length} peer(s)`;
        console.log((conf ? warn : ok)(`${r.project}: ${got}${conf ? `, ${conf} conflict(s) left for manual merge` : ''}`));
      }
    } catch (e) { console.log(bad(`${p.name}: ${e.message.split('\n')[0]}`)); }
  }
}

function help() {
  console.log(`${c.bold('claude-sync')} — sync Claude projects + history across computers

  doctor                       health + detected paths
  init --vault <folder>        point at the shared vault folder
  link <name> <localPath>      track a project folder
  link-all                     auto-detect and link all local projects (first machine)
  adopt [--root <dir>]         on a 2nd machine: link the vault's projects to local folders (by name; --root seeds the scan on a fresh machine)
  status                       what would push / pull
  push                         local -> vault (safe, additive)
  pull [--yes] [--force]       vault -> local (dry-run unless --yes; needs Claude closed)
  schedule install|status|remove   daily push-only background job (settings.scheduleAt)
  files status|push|pull       sync project FILES via git (remote ff, or vault bundles)
  project [list|on|off <name>]  per-project sync switch (off = excluded from push/pull/status)
  role [primary|secondary|clear]  make this machine the source of truth on conflicts (or defer)

GUI: \`npm run app\`.  Architecture: DESIGN.md.`);
}

const table = { doctor, init, link, 'link-all': linkAll, adopt, status: statusCmd, push, pull, schedule: scheduleCmd, files: filesCmd, project: projectCmd, role: roleCmd, help, '--help': help, '-h': help };

(async () => {
  const fn = table[cmd] || (cmd ? () => { console.log(bad(`unknown command: ${cmd}`)); help(); } : help);
  await fn();
})();
