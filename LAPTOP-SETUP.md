# Setting up a second computer

This walks through bringing a **second computer** into sync: pulling the sessions a
first machine published into the vault, so its conversations show up here
(transcripts + Recents tiles). It's written so you can hand it to Claude Code on the
second machine and have it run the steps.

Read `DESIGN.md` and `README.md` for the full picture. Until Syncthing transport
lands, the **vault** folder is moved between machines by hand (USB or any cloud
folder); after that it mirrors automatically.

## What you need on this computer

1. The **`claude-sync`** tool (this repo). Pure Node — no install needed to run the CLI.
2. The **vault** folder that the first machine filled with `claude-sync push`
   (holds its sessions, path-tokenized). Copy it over, or share it via cloud/USB.

## Facts the tool already handles (don't fight them)

- On Windows, Claude is a **Store (MSIX) app**; its data lives under
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, not `%APPDATA%\Claude`.
  `claude-sync doctor` detects this automatically.
- Session JSON must be **UTF-8 with no BOM** or Claude silently skips it. The tool
  only writes BOM-free.
- Writing Claude state needs Claude **fully closed** (it rewrites its own state on
  launch/quit); `pull` refuses to run while Claude is open.
- Transcript folders are named by an encoding of the absolute path; the tool
  re-encodes per machine.

## Steps

```bash
# 1. Node 18+ (install user-scope if missing, then use a fresh shell)
node --version
#   Windows: winget install --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent

# 2. Confirm the tool sees this machine's Claude
cd <path-to>/claude-sync
node bin/claude-sync.js doctor

# 3. Point at the vault that came from the first machine
node bin/claude-sync.js init --vault "<path-to>/vault"

# 4. Adopt the vault's projects (links them to local folders by name,
#    reusing the vault's project ids so pull lines up)
node bin/claude-sync.js adopt

# 5. Preview, then pull — with Claude fully closed
node bin/claude-sync.js status
node bin/claude-sync.js pull --yes
```

Reopen Claude. The first machine's conversations should appear as Recents tiles and
be resumable, with paths remapped to this machine.

### Notes

- `adopt` reports "no local folder found for: X" when a project's **files** aren't on
  this machine yet. Conversation pull needs the folder to exist — copy that project
  folder over first (file sync via git is on the roadmap), then re-run `adopt`.
- To publish this machine's own sessions back: `node bin/claude-sync.js push`, then
  move the vault back (or let Syncthing handle it once that lands).

## Report

After pulling, note: the `doctor`/`adopt`/`status` output, how many sessions landed,
whether the tiles show on reopen, and any project that came up "no local folder
found" (so you know which files still need to move).
