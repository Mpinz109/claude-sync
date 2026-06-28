#!/usr/bin/env node
// claude-sync CLI — the engine, also usable directly. GUI calls the same src/*.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, findBundledCli, claudeRunning } from '../src/platform.js';
import { loadConfig, saveConfig, addProject, linkProjects, setSetting } from '../src/config.js';
import { initVault } from '../src/vault.js';
import { pushAll, pullAll, adoptFromVault, discoverProjects, status as syncStatus } from '../src/sync.js';
import { gatherStatus } from '../src/status.js';
import { c, ok, warn, bad } from '../src/util.js';

const [, , cmd, ...args] = process.argv;

async function doctor() {
  const s = await gatherStatus();
  console.log(c.bold('\nclaude-sync doctor\n'));
  console.log(`${c.dim('platform')}      ${s.platform}`);
  console.log(`${c.dim('machine')}       ${s.machineName} ${c.dim(`(${s.machineId.slice(0, 8)})`)}`);
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

GUI: \`npm run app\`.  Architecture: DESIGN.md.`);
}

const table = { doctor, init, link, 'link-all': linkAll, adopt, status: statusCmd, push, pull, help, '--help': help, '-h': help };

(async () => {
  const fn = table[cmd] || (cmd ? () => { console.log(bad(`unknown command: ${cmd}`)); help(); } : help);
  await fn();
})();
