# claude-sync — design

Keep Claude Code projects (files **and** conversation history) in sync across
multiple computers. Two-way, peer-to-peer, cross-platform.

## Goals (from spec)

- **Scope:** project files (via git) + Claude history (transcripts, Recents tiles, project registration).
- **Transport:** peer-to-peer via **Syncthing** (a shared "vault" folder mirrored across machines).
- **Direction:** two-way **merge**, union by session id. On opening, the user is **prompted** to accept incoming changes. Settings control automation: `autoMerge`, `autoMergeIfNoConflicts`, `promptOnOpen`.
- **Platforms:** Windows (incl. the MSIX Store build), macOS, Linux.
- **Audience:** usable by a non-technical person. No CLI. A real installable desktop app.

## Application architecture (GUI-first)

A desktop app (**Electron**) is the product; the CLI is just the engine exposed for
power users and the scheduler.

```
+------------------------------------------------------+
|  Electron app (claude-sync)                          |
|  - renderer (GUI): Status / Devices / Projects /     |
|                    Schedule / Settings / Conflicts   |
|  - main process  = the engine (src/*) over IPC       |
|  - manages a bundled Syncthing as a child process    |
+----------------------------+-------------------------+
                             |
              bundled Syncthing binary (per OS)
        crypto Device IDs, pairing, P2P encrypted transfer,
        discovery/relay (public, or your AWS box)
```

- **Identity & transport = Syncthing, bundled.** The user never touches it. The app
  starts Syncthing on launch, reads the local **Device ID** (the crypto identity),
  shares the vault folder, and drives pairing through Syncthing's REST API.
- **Pairing (GUI):** Screen shows *your* Device ID as a QR + short code. To add a
  machine, scan/paste the other's code and click Pair; the app exchanges the IDs via
  Syncthing and auto-shares the vault. Optional: a self-hosted discovery/relay on AWS
  so pairing/NAT traversal run through infrastructure you control (just a config field).
- **Engine over IPC:** the renderer never touches the filesystem; it calls
  `engine:*` IPC handlers (doctor, listProjects, push, pull, status, settings,
  devices, schedule). Same engine the CLI uses.
- **Background presence:** runs in the tray/menubar; the 3am job and the on-open
  prompt are driven by the app, not a separate cron the user has to understand.
- **Packaging:** electron-builder produces a Windows installer (.exe/NSIS), macOS
  .dmg, and Linux AppImage/.deb, each bundling Node, the engine, and Syncthing.

## The three things we sync (learned the hard way)

| Thing | Windows (Store/MSIX) | macOS | Linux |
|---|---|---|---|
| Transcripts (`*.jsonl`) | `%USERPROFILE%\.claude\projects\<enc>\` | `~/.claude/projects/<enc>/` | `~/.claude/projects/<enc>/` |
| Project registration | `%USERPROFILE%\.claude.json` | `~/.claude.json` | `~/.claude.json` |
| Recents tiles (`*.json`) | `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code-sessions\` | `~/Library/Application Support/Claude/claude-code-sessions/` | (desktop app may be absent) |

Hard-won rules baked into the tool:
- Transcript **folder name = the absolute cwd with every non-alphanumeric char replaced by `-`**. Path changes per machine, so it must be re-encoded on each pull.
- Recents/registration JSON **must be UTF-8 with NO BOM** or the app silently skips it.
- On Windows the app data is in the **MSIX sandbox** (`...\Packages\Claude_*\LocalCache\Roaming\Claude`), not `%APPDATA%\Claude`.
- Edit while the app is **closed**; it rewrites its own state on launch/quit.

## Canonical "vault" (the Syncthing-shared folder)

Everything in the vault is **machine-independent** (paths tokenized).

```
vault/
  vault.json                      # version, vault id, known machines
  projects/
    <projectId>/
      project.json                # name, per-machine local paths, git remote/branch
      git/                        # bare mirror or bundles for the project files
      sessions/
        <sessionId>/
          meta.json               # title, cwd-token, model, timestamps, origin machine, contentHash
          transcript.jsonl        # path-TOKENIZED ({{PROJECT_ROOT}}, {{HOME}})
```

- A session is identified by its `sessionId` (`local_<uuid>`) + `cliSessionId` (transcript uuid).
- Paths inside transcripts/recents are tokenized: local project root -> `{{PROJECT_ROOT}}`, home -> `{{HOME}}`. Detokenized to local paths on pull.

## Merge model (two-way, union by id)

- **Pull = vault -> local.** For each vault session not present locally (by id), materialize it (detokenize, BOM-free) and add a Recents entry + registration.
- **Push = local -> vault.** For each local session not in the vault, tokenize and store it.
- **Conflict** = same `sessionId` present in both with different `contentHash` and neither is an ancestor of the other (diverged, e.g. continued on two machines). Resolution by settings:
  - `autoMerge=false` -> always prompt.
  - `autoMergeIfNoConflicts=true` -> apply non-conflicting changes automatically, prompt only on real conflicts.
  - `autoMerge=true` -> take newest by `lastActivityAt`, keep the other as a `*.fork` (never destroy data).
- **Files** are git's job: `project.json` records the remote/branch; `sync` runs fetch/merge (or exchanges bundles through the vault when there is no shared remote). Git keeps file history and conflict handling; we never let Syncthing touch a live `.git` working tree.

## Triggers: scheduled push + on-open pull

Sync is **infrequent and split by trigger**, because the two directions have very
different risk profiles:

- **Scheduled (default daily 03:00) = PUSH only.** Publishing this machine's new
  sessions to the vault is purely additive and never writes local Claude state, so
  it is safe to run fully unattended, with Claude open or the machine asleep. The
  scheduler is configured to **wake the machine** and **run-if-missed**. Optionally,
  if `autoMergeIfNoConflicts` is on, the scheduled job also pulls the *clean*
  (non-conflicting) incoming additions so they are simply there in the morning;
  real conflicts are queued for a human.
- **On open = PULL + merge, interactive.** Accepting incoming changes writes local
  Claude state (must be done with the app closed) and may conflict, so it stays
  interactive: the `hook open` check prompts per settings. This is the
  "prompted on opening" behavior from the spec.

Per-OS scheduler: Windows **Task Scheduler** (`schtasks`, wake + run-if-missed),
macOS **launchd LaunchAgent**, Linux **cron / systemd timer**.

## Commands

```
claude-sync doctor                 # detect OS, Claude paths, Syncthing, git; report health
claude-sync init [--vault <dir>]   # create config + vault skeleton; set machine id
claude-sync link <name> <path>     # map a local project folder to a vault project
claude-sync status                 # what would push/pull; conflicts
claude-sync pull [--yes]           # vault -> local (prompts per settings)
claude-sync push                   # local -> vault (additive, safe, unattended)
claude-sync sync [--unattended]    # push + (settings-gated) pull (+ git for files)
claude-sync config <key> [value]   # get/set settings (autoMerge, schedule time, etc.)
claude-sync hook open              # the on-open check: prompt for incoming changes
claude-sync schedule install [--at HH:MM] [--push-only]   # register the daily job
claude-sync schedule status | remove                      # inspect / unregister
```

## Safety

- Never write a BOM. Always `UTF8(no BOM)`.
- Refuse to write Claude state while a Claude process is running (warn + abort), like `fix_claude_recents.py`.
- Every destructive step backs up first; conflicts keep both sides (`.fork`).
- Dry-run by default on `pull` unless `--yes` or settings allow.

## Roadmap

1. **Foundation** (done): scaffold, cross-platform path resolver, `doctor`, config store.
2. **App shell** (in progress): Electron app, engine-over-IPC, GUI screens (Status live; Devices/Projects/Schedule/Settings scaffolded), tray.
3. **History round-trip**: `push`/`pull`/`status` for transcripts + recents + registration (machine -> vault -> machine), BOM-safe, path-tokenized.
4. **Syncthing manager**: bundle + supervise Syncthing; read Device ID; GUI pairing (QR/code) + auto-share the vault; optional AWS discovery/relay field.
5. **Merge + settings**: union-by-id, conflict detection, `autoMerge*`, the on-open conflict prompt in the GUI.
6. **Scheduling**: per-OS background job (Task Scheduler / launchd / cron); daily push-only by default, wake + run-if-missed; configured from the Schedule screen.
7. **Files via git**: per-project remote/bundle exchange; kept clear of Syncthing's live `.git`.
8. **Packaging**: electron-builder installers (Win/macOS/Linux) bundling Node + engine + Syncthing; auto-start on login; first-run onboarding.

## Settings (config.json)

- `autoMerge` (bool, default false) — auto-resolve conflicts by newest, keep loser as `.fork`.
- `autoMergeIfNoConflicts` (bool, default true) — apply non-conflicting incoming changes without prompting (incl. in the scheduled job).
- `promptOnOpen` (bool, default true) — run the pull prompt when Claude opens.
- `scheduleAt` (HH:MM, default "03:00") and `schedulePushOnly` (bool, default true).
