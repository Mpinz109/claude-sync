// The sync-mode orchestrator: one entry point that runs whatever the user's
// syncMode asks for. Used by the CLI `sync` command, the GUI's Sync-all button,
// and the scheduled background job.
//
//   push        engine push only (publish local sessions to the local vault)
//   pull        receive only: cloud pull -> engine pull (SKIPS itself if
//               Claude is running, unless forced). Never publishes.
//   push-cloud  cloud pull -> engine push -> cloud push (never writes Claude
//               state, safe unattended with Claude open)
//   full        cloud pull -> engine pull (skips if Claude is running,
//               unless forced) -> engine push -> cloud push
//
// Every step lands in report.steps so callers can render exactly what happened.

import { loadConfig } from './config.js';
import { resolvePaths } from './platform.js';
import { pushAll, pullAll } from './sync.js';
import { S3, loadAwsCreds } from './s3.js';
import { cloudPush, cloudPull } from './cloud.js';

export const SYNC_MODES = ['push', 'pull', 'push-cloud', 'full'];

/** Build the cloud mirror context from settings, or explain why not. */
export function cloudContext(cfg) {
  const st = cfg.settings || {};
  if (!st.s3Bucket) return null; // cloud not configured — not an error
  const creds = loadAwsCreds(st.awsProfile || 'default');
  if (!creds) return { error: 'no AWS credentials (see docs/aws-setup.md)' };
  return {
    vaultDir: cfg.vaultDir,
    s3: new S3({ bucket: st.s3Bucket, region: st.s3Region, creds }),
    prefix: st.s3Prefix || 'vault/',
    passphrase: st.vaultPassphrase || '',
  };
}

export async function runSync({
  mode,
  force = false,
  cfg = loadConfig(),
  paths = resolvePaths(),
  cloud, // injectable for tests; undefined = derive from settings
} = {}) {
  mode = mode || cfg.settings?.syncMode || 'push';
  if (!SYNC_MODES.includes(mode)) throw new Error(`unknown sync mode: ${mode} (${SYNC_MODES.join('|')})`);
  const report = { mode, steps: [] };
  if (!cfg.vaultDir) throw new Error('No vault configured. Run init first.');

  const ctx = cloud === undefined ? cloudContext(cfg) : cloud;
  const wantCloud = mode !== 'push';
  if (wantCloud && ctx?.error) report.steps.push({ step: 'cloud', skipped: ctx.error });
  const useCloud = wantCloud && ctx && !ctx.error;

  // 1) Bring the vault current BEFORE merging/publishing, so merges see
  //    everything other machines already published.
  if (useCloud) report.steps.push({ step: 'cloud-pull', ...(await cloudPull(ctx)) });

  // 2) Merge the vault into local Claude (full + pull modes). pullAll blocks
  //    itself when Claude is running (that's the safety, not a failure).
  if (mode === 'full' || mode === 'pull') {
    const r = await pullAll(cfg, paths, { dryRun: false, force });
    report.steps.push(r.blocked ? { step: 'pull', skipped: r.reason } : { step: 'pull', results: r.results });
  }

  // 3) Publish local sessions (every mode except receive-only pull).
  if (mode !== 'pull') report.steps.push({ step: 'push', results: pushAll(cfg, paths) });

  // 4) Mirror the now-updated vault up (pull mode published nothing, skip).
  if (useCloud && mode !== 'pull') report.steps.push({ step: 'cloud-push', ...(await cloudPush(ctx)) });

  return report;
}

/** One-line human summary of a runSync report. */
export function summarizeRun(report) {
  const bits = [];
  for (const s of report.steps) {
    if (s.skipped) { bits.push(`${s.step} skipped (${s.skipped})`); continue; }
    if (s.step === 'cloud-pull') bits.push(`cloud↓${s.downloaded.length}`);
    else if (s.step === 'cloud-push') bits.push(`cloud↑${s.uploaded.length}`);
    else if (s.step === 'push') {
      const n = s.results.reduce((a, r) => a + r.pushed.length, 0);
      const u = s.results.reduce((a, r) => a + (r.updated?.length || 0), 0);
      bits.push(`pushed ${n}${u ? `+${u} updated` : ''}`);
    } else if (s.step === 'pull') {
      const n = s.results.reduce((a, r) => a + r.pulled.length, 0);
      const m = s.results.reduce((a, r) => a + (r.merged?.length || 0), 0);
      const c = s.results.reduce((a, r) => a + (r.conflicts?.length || 0), 0);
      bits.push(`pulled ${n}${m ? `, merged ${m}` : ''}${c ? `, ${c} conflict(s)` : ''}`);
    }
  }
  return `[${report.mode}] ${bits.join(' · ')}`;
}
