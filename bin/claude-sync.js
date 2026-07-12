#!/usr/bin/env node
// claude-sync CLI — the engine, also usable directly. GUI calls the same src/*.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, findBundledCli, claudeRunning } from '../src/platform.js';
import { loadConfig, saveConfig, addProject, linkProjects, setSetting, setProjectSync } from '../src/config.js';
import { initVault, registerMachine } from '../src/vault.js';
import { pushAll, pullAll, adoptFromVault, discoverProjects, status as syncStatus } from '../src/sync.js';
import { gatherStatus } from '../src/status.js';
import { tidyRegistration, dedupeVault } from '../src/maintain.js';
import { Relay, DEFAULT_PORT } from '../src/relay.js';
import { S3, loadAwsCreds } from '../src/s3.js';
import { cloudPush, cloudPull, cloudSync } from '../src/cloud.js';
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
  const remote = gitsync.getRemoteUrl(localPath);
  const id = addProject(name, localPath, remote);
  console.log(ok(`linked "${name}" -> ${localPath} ${c.dim(`(${id.slice(0, 8)})`)}${remote ? c.dim(` git:${remote}`) : ''}`));
}

function linkAll() {
  const d = discoverProjects().map((p) => ({ ...p, gitRemote: gitsync.getRemoteUrl(p.localPath) }));
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
  for (const r of results) {
    let line = `${r.project}: pushed ${r.pushed.length}, updated ${r.updated?.length ?? 0}, already there ${r.skipped.length}`;
    console.log(ok(line));
    if (r.pushConflicts?.length) console.log(warn(`  ${r.pushConflicts.length} session(s) unrelated to their vault copy, left alone: ${r.pushConflicts.map((id) => id.slice(0, 8)).join(', ')}`));
  }
}

async function pull() {
  const dryRun = !args.includes('--yes');
  const res = await pullAll(undefined, undefined, { dryRun, force: args.includes('--force') });
  if (res.blocked) { console.log(warn(res.reason)); return; }
  for (const r of res.results) {
    if (dryRun) {
      let line = `${r.project}: ${r.pulled.length} would be pulled`;
      if (r.merged?.length) line += `, ${r.merged.length} would merge`;
      if (r.conflicts.length) line += warn(`, ${r.conflicts.length} conflict(s)`);
      console.log(line);
    } else {
      let line = `${r.project}: pulled ${r.pulled.length}, merged ${r.merged?.length ?? 0}, already local ${r.skipped.length}`;
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

async function relayCmd() {
  const pi = args.indexOf('--port');
  const ti = args.indexOf('--token');
  const relay = new Relay({
    port: pi >= 0 ? Number(args[pi + 1]) : DEFAULT_PORT,
    token: ti >= 0 ? args[ti + 1] : 'claude-migrate',
  });
  const port = await relay.start();
  console.log(ok(`agent relay listening on 0.0.0.0:${port} (${relay.messages.length} message(s) in history)`));
  console.log(c.dim(`store: ${relay.store}`));
  console.log(c.dim('connect Claude sessions via bin/claude-sync-mcp.js — see `claude-sync help`. Ctrl+C to stop.'));
  await new Promise(() => {}); // run until killed
}

async function tidy() {
  const apply = args.includes('--yes');
  const cfg = loadConfig();

  // 1) vault: merge duplicate project records (safe while Claude runs).
  if (cfg.vaultDir) {
    const r = dedupeVault(cfg, { apply });
    if (!r.merged.length) console.log(ok('vault: no duplicate project records'));
    for (const m of r.merged) {
      console.log((apply ? ok : warn)(`vault: "${m.name}" ${apply ? 'merged' : 'would merge'} ${m.moved.length} session(s) from ${m.retired.slice(0, 8)} into ${m.canonical.slice(0, 8)}`));
      if (m.skipped.length) console.log(warn(`  ${m.skipped.length} session id(s) exist in both records — left in place, resolve via pull conflicts`));
    }
    if (apply && r.repointed.length) { saveConfig(cfg); console.log(c.dim(`  relinked locally: ${r.repointed.join(', ')}`)); }
  } else {
    console.log(c.dim('vault: not configured, skipping'));
  }

  // 2) linked paths: normalize to native separators. Not cosmetic — tokenize()
  // matches the project root as a raw string, so a forward-slash root fails to
  // tokenize the backslash paths inside real transcripts and leaks them.
  const cfgNative = { ...cfg, projects: cfg.projects.map((p) => ({ ...p, localPath: path.resolve(p.localPath) })) };
  let cfgChanged = false;
  for (let i = 0; i < cfg.projects.length; i++) {
    if (cfgNative.projects[i].localPath !== cfg.projects[i].localPath) {
      cfgChanged = true;
      console.log((apply ? ok : warn)(`config: ${apply ? 'normalized' : 'would normalize'} linked path for "${cfg.projects[i].name}" to native separators`));
    }
  }
  if (apply && cfgChanged) saveConfig(cfgNative);

  // 3) .claude.json registration (writing Claude state needs Claude closed).
  const running = await claudeRunning();
  if (apply && running && !args.includes('--force')) {
    console.log(warn('registration: skipped — Claude is running (close it and re-run, or --force)'));
  } else {
    const r = tidyRegistration(undefined, { apply, cfg: cfgNative });
    if (!r.removed.length && !r.merged.length && !r.rekeyed.length) console.log(ok('registration: clean'));
    for (const k of r.removed) console.log((apply ? ok : warn)(`registration: ${apply ? 'removed' : 'would remove'} dead entry ${c.dim(k)}`));
    for (const k of r.merged) console.log((apply ? ok : warn)(`registration: ${apply ? 'merged' : 'would merge'} duplicate ${c.dim(k)}`));
    for (const k of r.rekeyed) console.log((apply ? ok : warn)(`registration: ${apply ? 'rekeyed' : 'would rekey'} ${c.dim(k.from)} -> ${c.dim(k.to)}`));
  }
  if (!apply) console.log(c.dim('\ndry run — re-run with `claude-sync tidy --yes` to apply.'));
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

function configCmd() {
  const [key, ...rest] = args;
  const cfg = loadConfig();
  if (!key) {
    for (const [k, v] of Object.entries(cfg.settings)) {
      const shown = k === 'vaultPassphrase' && v ? '(set)' : JSON.stringify(v);
      console.log(`  ${k.padEnd(24)} ${shown}`);
    }
    return;
  }
  if (!rest.length) {
    const v = cfg.settings[key];
    console.log(key === 'vaultPassphrase' && v ? '(set)' : JSON.stringify(v));
    return;
  }
  let value = rest.join(' ');
  if (value === 'true') value = true;
  else if (value === 'false') value = false;
  try { setSetting(key, value); console.log(ok(`${key} = ${key === 'vaultPassphrase' ? '(set)' : JSON.stringify(value)}`)); }
  catch (e) { console.log(bad(e.message)); }
}

async function cloudCmd() {
  const sub = args[0] || 'info';
  const cfg = loadConfig();
  const st = cfg.settings;
  if (sub === 'set') {
    // claude-sync cloud set <bucket> [region] [prefix]
    const [, bucket, region, prefix] = args;
    if (!bucket) { console.log(bad('usage: claude-sync cloud set <bucket> [region] [prefix]')); return; }
    setSetting('s3Bucket', bucket);
    if (region) setSetting('s3Region', region);
    if (prefix) setSetting('s3Prefix', prefix.endsWith('/') ? prefix : `${prefix}/`);
    console.log(ok(`cloud vault: s3://${bucket}/${prefix || st.s3Prefix} (${region || st.s3Region})`));
    return;
  }
  if (sub === 'info') {
    if (!st.s3Bucket) { console.log(warn('cloud sync off — configure with `claude-sync cloud set <bucket> [region]` (see docs/aws-setup.md)')); return; }
    const creds = loadAwsCreds(st.awsProfile);
    console.log(`bucket   s3://${st.s3Bucket}/${st.s3Prefix} (${st.s3Region})`);
    console.log(creds ? ok(`credentials found (profile "${st.awsProfile}" or env)`) : bad('no AWS credentials — see docs/aws-setup.md'));
    console.log(st.vaultPassphrase ? ok('client-side encryption ON') : c.dim('client-side encryption off (set vaultPassphrase to enable)'));
    return;
  }
  if (!['push', 'pull', 'sync'].includes(sub)) { console.log(bad('usage: claude-sync cloud info|set|push|pull|sync')); return; }
  if (!cfg.vaultDir) { console.log(bad('no local vault — run init first')); return; }
  if (!st.s3Bucket) { console.log(bad('no bucket — run `claude-sync cloud set <bucket> [region]` first')); return; }
  const creds = loadAwsCreds(st.awsProfile);
  if (!creds) { console.log(bad('no AWS credentials (env or ~/.aws/credentials) — see docs/aws-setup.md')); return; }
  const s3 = new S3({ bucket: st.s3Bucket, region: st.s3Region, creds });
  const opts = { vaultDir: cfg.vaultDir, s3, prefix: st.s3Prefix, passphrase: st.vaultPassphrase };
  try {
    if (sub === 'push') { const r = await cloudPush(opts); console.log(ok(`cloud push: uploaded ${r.uploaded.length}, unchanged ${r.unchanged}`)); }
    else if (sub === 'pull') { const r = await cloudPull(opts); console.log(ok(`cloud pull: downloaded ${r.downloaded.length}, unchanged ${r.unchanged}`)); }
    else { const r = await cloudSync(opts); console.log(ok(`cloud sync: downloaded ${r.pull.downloaded.length}, uploaded ${r.push.uploaded.length}`)); }
  } catch (e) { console.log(bad(`cloud ${sub} failed: ${e.message.split('\n')[0]}`)); }
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
  cloud info|set|push|pull|sync   mirror the vault to your own S3 bucket (store-and-forward; optional encryption)
  config [key] [value]         list / read / set settings (e.g. vaultPassphrase, scheduleAt)
  tidy [--yes]                 fix duplicate projects: merge dup vault records, clean dead/variant registrations
  relay [--port N] [--token T] run the agent message relay (Claude sessions connect via bin/claude-sync-mcp.js)

GUI: \`npm run app\`.  Architecture: DESIGN.md.`);
}

const table = { doctor, init, link, 'link-all': linkAll, adopt, status: statusCmd, push, pull, schedule: scheduleCmd, files: filesCmd, project: projectCmd, role: roleCmd, cloud: cloudCmd, config: configCmd, tidy, relay: relayCmd, help, '--help': help, '-h': help };

(async () => {
  const fn = table[cmd] || (cmd ? () => { console.log(bad(`unknown command: ${cmd}`)); help(); } : help);
  await fn();
})();
