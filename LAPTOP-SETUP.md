# Task for Claude Code (run this on the LAPTOP)

You are Claude Code on Maxwell's **laptop**. A tool called **claude-sync** was built
on his desktop to sync Claude Code projects + conversation history across his
computers. Your job: set it up on this laptop and **pull** the sessions the desktop
published, so its conversations show up here (transcripts + Recents tiles). Then
optionally **push** this laptop's own sessions back.

Read `DESIGN.md` and `README.md` in this same folder for the full architecture. The
short version and exact steps are below. Syncthing transport is not built yet
(Phase 4), so for this first test the "vault" is moved by hand (USB/cloud).

## What should be on the USB / handoff drive

1. The **`claude-sync`** folder (this repo — the tool). Pure Node, no install needed to run the CLI.
2. A **`claude-vault`** folder — the canonical store the desktop filled with `claude-sync push`. This holds the desktop's sessions, path-tokenized.

If either is missing, ask Maxwell to copy them over from the desktop.

## Critical facts (already handled by the tool, do not fight them)

- Claude on Windows is a **Store (MSIX) app**; its data is under
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, NOT `%APPDATA%\Claude`.
  `claude-sync doctor` detects this automatically.
- Session JSON must be **UTF-8 with no BOM**, or Claude silently skips it. The tool
  only ever writes BOM-free; do not introduce a BOM if you touch these files.
- Writing Claude state requires Claude to be **fully closed** (it rewrites its own
  state on launch/quit). `claude-sync pull` refuses to run while Claude is open.
- Project folders' transcript dirs are named by an **encoding of the absolute path**
  (every non-alphanumeric -> `-`). The tool re-encodes per machine; you don't.

## Steps

### 1. Make sure Node 18+ is available
```powershell
node --version
```
If missing, install user-scope (no admin prompt), then use a fresh PowerShell window:
```powershell
winget install --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent
```

### 2. Sanity check the tool sees this laptop's Claude
```powershell
cd <path-to>\claude-sync
node bin/claude-sync.js doctor
```
Confirm it reports this laptop's transcripts/recents counts and "claude not running".

### 3. Point at the vault that came from the desktop
```powershell
node bin/claude-sync.js init --vault "<path-to>\claude-vault"
```

### 4. Adopt the vault's projects onto this laptop
This links each project the desktop published to the matching local folder on this
laptop (matched by folder name), reusing the vault's project IDs so pull lines up:
```powershell
node bin/claude-sync.js adopt
```
- "adopted X -> path" means matched and linked.
- "no local folder found for: Y" means that project's files aren't on this laptop
  yet. That's expected for projects the laptop doesn't have. Conversation pull needs
  the folder to exist; if Maxwell wants those, copy the project folder over first,
  then re-run `adopt`. (Automatic file sync is Phase 5 / git.)

### 5. Preview, then pull (with Claude CLOSED)
```powershell
node bin/claude-sync.js status            # shows how many sessions would pull per project
# fully quit Claude: all windows + tray + confirm no Claude.exe in Task Manager
node bin/claude-sync.js pull --yes
```

### 6. Verify
Reopen Claude on the laptop. The desktop's conversations should appear as Recents
tiles and be resumable, with paths remapped to this laptop's locations.

## Optionally: publish this laptop's sessions back
```powershell
node bin/claude-sync.js push
```
Then copy the `claude-vault` folder back to the desktop (or just wait for Phase 4,
when Syncthing mirrors it automatically) and run `pull` there.

## Report back to Maxwell
- Output of `doctor`, `adopt`, and `status`.
- After pull: how many sessions landed, and whether the tiles show on reopen.
- Any project that came up "no local folder found" (so we know what files still
  need to move).
