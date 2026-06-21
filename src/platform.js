// Cross-platform resolver for where Claude stores its data.
// Encapsulates every OS quirk we learned: the Windows MSIX sandbox, the
// transcript path-encoding, and the locations of transcripts / registration /
// recents on Windows, macOS, and Linux.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Claude Code's project-folder encoding: every non-alphanumeric char -> '-'. */
export function encodeCwd(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

function firstExisting(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * On Windows the Claude desktop app may be a Store (MSIX) package whose data is
 * redirected into %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude.
 * Detect it dynamically (the publisher hash differs per build/user). Falls back
 * to a classic %APPDATA%\Claude install if present.
 */
function windowsAppDataBase() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const pkgRoot = path.join(local, 'Packages');
  let sandbox = null;
  try {
    const matches = fs.readdirSync(pkgRoot).filter((n) => /^Claude_/i.test(n));
    for (const m of matches) {
      const cand = path.join(pkgRoot, m, 'LocalCache', 'Roaming', 'Claude');
      if (fs.existsSync(cand)) { sandbox = cand; break; }
    }
  } catch { /* no Packages dir */ }
  return firstExisting([sandbox, path.join(roaming, 'Claude')]) || sandbox || path.join(roaming, 'Claude');
}

function macAppDataBase() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
}

function linuxAppDataBase() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return firstExisting([path.join(cfg, 'Claude'), path.join(os.homedir(), '.claude-app')]) || path.join(cfg, 'Claude');
}

/**
 * Resolve all Claude paths for this machine. Any field can be overridden via
 * config.overrides (so users on odd setups can correct detection).
 */
export function resolvePaths(overrides = {}) {
  const home = os.homedir();
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'

  let appDataBase;
  if (platform === 'win32') appDataBase = windowsAppDataBase();
  else if (platform === 'darwin') appDataBase = macAppDataBase();
  else appDataBase = linuxAppDataBase();

  const paths = {
    platform,
    home,
    appDataBase,
    claudeJson: path.join(home, '.claude.json'),          // project registration (real profile, shared)
    transcriptsDir: path.join(home, '.claude', 'projects'), // transcripts (real profile, shared)
    recentsDir: path.join(appDataBase, 'claude-code-sessions'), // Recents tiles (in app sandbox on Windows)
    cliDir: path.join(appDataBase, 'claude-code'),          // bundled CLI versions live here
  };
  return { ...paths, ...overrides };
}

/** Find the newest bundled `claude` CLI binary, or null if none. */
export function findBundledCli(paths) {
  const dir = paths.cliDir;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const versions = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(dir, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const v of versions) {
      const p = path.join(dir, v.name, exe);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* none */ }
  return null;
}

/** True if a Claude process appears to be running (best effort, per OS). */
export async function claudeRunning() {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((res) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => res(err ? '' : String(stdout)));
  });
  try {
    if (process.platform === 'win32') {
      const out = await run('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH']);
      return /Claude\.exe/i.test(out);
    }
    const out = await run('pgrep', ['-i', 'claude']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
