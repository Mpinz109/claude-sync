# claude-sync — guide for a new agent session

You are picking up **claude-sync**, a tool that syncs Claude Code **projects
(files via git)** and **conversation history (transcripts + Recents tiles + project
registration)** across multiple computers — two-way, peer-to-peer via **Syncthing**,
cross-platform (Windows/macOS/Linux), with a **desktop GUI usable by non-technical
people**. Public repo: https://github.com/Mpinz109/claude-sync

Read this whole file, then `DESIGN.md` (architecture + roadmap). This file is the
fast on-ramp; DESIGN.md is the source of truth for design.

## Current status

Working and verified: the cross-platform path engine, BOM-safe IO, config store,
the canonical vault, path tokenization, and the **history round-trip**
(`push`/`pull`/`status`, union by `cliSessionId`, byte-exact round-trip). The
Electron GUI shell exists (Status live; Devices/Projects/Schedule/Settings wired
over IPC). CLI: `doctor, init, link, link-all, adopt, status, push, pull`.

Phases 1–3 + sync-all/adopt are done. **Next up is Phase 4 (Syncthing).** See the
roadmap in DESIGN.md.

## Non-negotiable facts (these were learned painfully — do not relearn them)

1. **Never write a UTF-8 BOM.** Claude's JSON parser silently skips any file that
   starts with `EF BB BF`. Always write via `src/util.js` (`writeText`/`writeJson`),
   which use Node's BOM-free `utf8`. Watch out for tooling that adds a BOM
   (PowerShell `Set-Content -Encoding UTF8` does — never use it for these files).
2. **Windows Claude is a Store (MSIX) app.** Its data is under
   `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, NOT `%APPDATA%\Claude`.
   `src/platform.js` detects the package dir dynamically. A normal terminal sees
   `%APPDATA%\Claude` as empty; the terminal tab *inside* the Claude app is sandboxed
   and can't see the real files — always use a normal external shell.
3. **Transcript folder name = the absolute cwd with every non-alphanumeric char
   replaced by `-`** (`encodeCwd`). Paths differ per machine, so re-encode on pull.
4. **Writing Claude state needs Claude fully closed** (it rewrites its own state on
   launch/quit). `pull` refuses to run while Claude is running (`claudeRunning()`).
5. **Recents tiles are just JSON files** in `claude-code-sessions/<acct>/<org>/`,
   read by the app — no LevelDB editing needed. The `<acct>/<org>` guid folders are
   the same across one account's machines.
6. **OneDrive folders are reparse points.** `fs.readdirSync(dir, {withFileTypes:true})`
   returns them as Dirents whose `isDirectory()` is **false** (they look like
   symlinks), so any dir-scan that trusts `Dirent.isDirectory()` silently skips every
   OneDrive-backed folder. Always `fs.statSync(full).isDirectory()` (it follows the
   reparse). Project folders are frequently under OneDrive Desktop, so this matters
   for every filesystem scan in the tool.

## Where things live

| Path | What |
|---|---|
| `src/platform.js` | per-OS path resolution, `encodeCwd`, CLI discovery, `claudeRunning` |
| `src/util.js` | BOM-safe read/write, BOM strip, colors |
| `src/config.js` | `~/.claude-sync/config.json` (machineId, projects, devices, settings) |
| `src/vault.js` | the shared vault (sessions, project records, manifest) |
| `src/tokens.js` | tokenize/detokenize paths (`{{PROJECT_ROOT}}`, `{{HOME}}`) |
| `src/local.js` | read/write this machine's transcripts, recents, registration |
| `src/sync.js` | `push/pull/status/syncAll/discoverProjects/adoptFromVault` |
| `src/status.js` | structured status for CLI `doctor` + GUI |
| `src/syncthing.js` | **skeleton** — Phase 4 fills this in |
| `bin/claude-sync.js` | the CLI |
| `app/main.js` | Electron main = the engine over IPC |
| `app/preload.cjs` | IPC bridge (CommonJS on purpose) |
| `app/renderer/*` | the GUI (degrades gracefully without Electron for preview) |

## Conventions

- **ESM** everywhere (`"type": "module"`), except `app/preload.cjs` (preload must be CommonJS).
- **The engine (`src/`) has zero runtime dependencies** — keep it that way; only the
  GUI/build tooling may add deps. The CLI must run with bare `node`.
- Sync model: **additive, union by `cliSessionId`.** Never destroy data; conflicts
  keep both sides (a `.fork`). Merge/conflict UI is Phase 5.
- All session/registration writes go through `src/util.js` (BOM-free).

## How to run / test

```bash
node bin/claude-sync.js doctor      # detect Claude + paths on this machine
node bin/claude-sync.js help
npm install && npm run app          # the GUI (Electron)
node --check <file>                 # syntax-check edited JS
```

Safe testing pattern (no risk to real Claude state): construct an in-memory `cfg`
with a TEMP `vaultDir` and call `pushProject` / `pullProject({dryRun:true})` /
`status` directly; assert `detokenize(tokenize(x)) === x`. (That's how Phase 3 was
verified.) Never point a real `pull --yes` at a machine with Claude open.

## Environment notes

- Needs **Node 18+**. On Windows it may be installed user-scope and not on PATH;
  if `node` isn't found, install with `winget install --id OpenJS.NodeJS.LTS --scope user`
  and use a fresh shell, or resolve it under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_*`.
- `git` + `gh` are used for the repo. The remote `origin` is the GitHub repo above;
  default branch `main`.

## What to build next (in order)

1. **Phase 4 — Syncthing manager** (`src/syncthing.js`): bundle a Syncthing binary
   per OS, supervise it as a child process, read this machine's **Device ID**, drive
   pairing + auto-share the vault folder via Syncthing's REST API. Surface Device ID
   + pairing (paste/QR) in the GUI Devices screen. Optional self-hosted discovery/relay
   field (AWS). This removes the manual "move the vault" step.
2. **Phase 5 — Merge + conflict UI**: detect divergent sessions (same id, different
   `contentHash`); honor `autoMerge` / `autoMergeIfNoConflicts`; build the on-open
   prompt (`hook open`).
3. **Phase 6 — Scheduling**: per-OS background job (Task Scheduler / launchd / cron),
   daily push-only by default, wake + run-if-missed, configured from the Schedule screen.
4. **Phase 7 — Files via git**: per-project remote/bundle exchange; never let
   Syncthing touch a live `.git` working tree.
5. **Phase 8 — Packaging**: electron-builder installers (Win `.exe`, macOS `.dmg`,
   Linux AppImage) bundling Node + engine + Syncthing; a `.github/workflows` that
   builds them on each tag and attaches to a GitHub Release; optional `npm publish`.

## Git

- Branch off `main` for changes; commit in logical chunks.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Don't commit secrets; `~/.claude-sync/config.json` is outside the repo by design.
