// Reading and writing THIS machine's Claude state: transcripts, recents entries,
// and project registration. All writes are BOM-free (the rule that cost us hours).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeCwd } from './platform.js';
import { normalizePath } from './config.js';
import { readJson, writeJson, writeText, readText } from './util.js';

const TRUSTED_PROJECT = {
  allowedTools: [], mcpContextUris: [], enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true, projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};

/** Scan claude-code-sessions once: cliSessionId -> { entry, file, sessionId }. */
export function readRecentsIndex(paths) {
  const root = paths.recentsDir;
  const index = new Map();
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) {
        try {
          const obj = readJson(full);
          if (obj.cliSessionId) index.set(obj.cliSessionId, { entry: obj, file: full, sessionId: obj.sessionId });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(root);
  return index;
}

/** Where to drop new recents entries: the existing account/org guid folder. */
export function detectRecentsTargetDir(paths) {
  let found = null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    let hasJson = false;
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.json')) hasJson = true;
    }
    if (hasJson && !found) found = d;
  };
  walk(paths.recentsDir);
  return found;
}

/** Sessions that exist locally for a given project path. */
export function listLocalSessions(paths, localPath, recentsIndex = readRecentsIndex(paths)) {
  const dir = path.join(paths.transcriptsDir, encodeCwd(localPath));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { /* none */ }
  return files.map((f) => {
    const cliSessionId = f.slice(0, -'.jsonl'.length);
    const rec = recentsIndex.get(cliSessionId) || null;
    return {
      cliSessionId,
      transcriptPath: path.join(dir, f),
      recentsEntry: rec ? rec.entry : null,
      sessionId: rec ? rec.sessionId : null,
    };
  });
}

export function localHasSession(paths, localPath, cliSessionId) {
  return fs.existsSync(path.join(paths.transcriptsDir, encodeCwd(localPath), `${cliSessionId}.jsonl`));
}

export function readTranscript(p) { return readText(p); }
export function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

/** Materialize a transcript locally (BOM-free) under the project's encoded folder. */
export function writeLocalTranscript(paths, localPath, cliSessionId, jsonlText) {
  const file = path.join(paths.transcriptsDir, encodeCwd(localPath), `${cliSessionId}.jsonl`);
  writeText(file, jsonlText);
  return file;
}

/**
 * Preserve the losing side of a conflict next to the session as `<id>.fork`
 * (NOT `.jsonl`, so Claude never loads it as a live session and listLocalSessions
 * ignores it). Never destroy data — this is the keep-the-loser path.
 */
export function writeLocalTranscriptFork(paths, localPath, cliSessionId, jsonlText) {
  const file = path.join(paths.transcriptsDir, encodeCwd(localPath), `${cliSessionId}.fork`);
  writeText(file, jsonlText);
  return file;
}

/**
 * Undo snapshot: before a merge/overwrite touches a live transcript, copy the
 * current bytes to `<id>.<stamp>.undo` beside it (never `.jsonl`, so Claude and
 * listLocalSessions ignore it). Cheap insurance on top of the .fork rule.
 */
export function snapshotLocalTranscript(paths, localPath, cliSessionId) {
  const file = path.join(paths.transcriptsDir, encodeCwd(localPath), `${cliSessionId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(paths.transcriptsDir, encodeCwd(localPath), `${cliSessionId}.${stamp}.undo`);
  fs.copyFileSync(file, dest);
  return dest;
}

/** Write a recents entry (BOM-free) into the detected guid folder. Returns path or null. */
export function writeLocalRecents(paths, entryObj) {
  const dir = detectRecentsTargetDir(paths);
  if (!dir) return null; // no existing structure to place it in
  if ('transcriptUnavailable' in entryObj) entryObj.transcriptUnavailable = false;
  const file = path.join(dir, `${entryObj.sessionId}.json`);
  writeText(file, JSON.stringify(entryObj));
  return file;
}

/** Ensure a project is trusted/registered in .claude.json (BOM-free). */
export function registerProject(paths, localPath) {
  const file = paths.claudeJson;
  const cfg = fs.existsSync(file) ? readJson(file) : {};
  cfg.projects = cfg.projects || {};
  // Compare normalized, not raw: a slash/case variant of an existing key would
  // otherwise register the same project twice (the app then lists it twice).
  const np = normalizePath(localPath);
  if (Object.keys(cfg.projects).some((k) => normalizePath(k) === np)) return false;
  cfg.projects[localPath] = { ...TRUSTED_PROJECT };
  writeJson(file, cfg);
  return true;
}
