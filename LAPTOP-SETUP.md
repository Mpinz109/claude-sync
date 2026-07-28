# Setting up a new computer

Bring a brand-new machine into sync: it receives every project's conversations
(transcripts + Recents tiles) and starts participating in daily sync. Written so
you can hand it to Claude Code on the new machine and have it run the steps.

Two transports for the first sync — pick one:
- **Cloud (recommended):** the vault lives in your S3 bucket; the new machine
  pulls it. Needs the one-time AWS setup in [docs/aws-setup.md](docs/aws-setup.md).
- **USB/folder copy:** carry the vault folder over by hand. No AWS needed.

## 0. Prerequisites on the new machine

1. **Claude** installed and signed in (same account).
2. **Node 18+** (`node --version`). Windows, no admin needed:
   `winget install --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent` (then open a fresh shell).
3. **git** (usually present; `winget install Git.Git` if not).
4. The tool: `git clone https://github.com/Mpinz109/claude-sync` and `cd claude-sync`.
   The CLI is zero-dependency — no npm install needed unless you want the GUI
   (`npm install && npm run app`).

## 1. Project FILES come first

Conversations attach to project folders, so the folders must exist before adopt.
Either `git clone` each project that has a remote, or copy the projects root
(e.g. `Random Claude Projects`) over USB/network — skip `node_modules`/`.venv`,
they rebuild. Note the absolute path of the projects root here.

## 2. Point at the vault

```bash
node bin/claude-sync.js init --vault "<local vault folder, e.g. %USERPROFILE%\Desktop\claude-vault>"
```

**Cloud transport:** put the AWS key in `~/.aws/credentials` (see
docs/aws-setup.md — each machine can have its own key), then:
```bash
node bin/claude-sync.js cloud set <bucket> <region>
node bin/claude-sync.js config vaultPassphrase "<same passphrase as the other machines, if set>"
node bin/claude-sync.js cloud pull
```

**USB transport:** copy the `claude-vault` folder from the other machine into
the path you gave `init`.

## 3. Adopt, preview, pull

```bash
node bin/claude-sync.js doctor                       # sanity: paths + counts detected
node bin/claude-sync.js adopt --root "<projects root from step 1>"
node bin/claude-sync.js status                       # preview what will arrive
# fully close Claude (all windows + tray + no Claude.exe in Task Manager)
node bin/claude-sync.js pull --yes
```

Reopen Claude: every project's conversations should appear as Recents tiles,
paths remapped to this machine (different username/folder layout is fine —
that's handled).

## 4. Make it permanent

```bash
node bin/claude-sync.js config syncMode full         # or pull / push-cloud / push
node bin/claude-sync.js schedule install             # daily background sync (default 03:00)
```

`full` is right for a machine you work on (publish + receive; the merge step
auto-skips while Claude is open). `pull` for a mirror-only machine. The GUI
(`npm run app`) manages all of this too: Settings for modes, Projects for
per-project switches, Devices for pairing.

## Facts the tool already handles (don't fight them)

- Windows Store Claude keeps its data in the MSIX sandbox
  (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`); regular
  installs use `%APPDATA%\Claude`. `doctor` detects both.
- Session JSON must be UTF-8 with **no BOM**; the tool only writes BOM-free.
- Writing Claude state needs Claude fully closed; `pull` guards itself.
- Transcript folders are named by an encoding of the absolute project path;
  re-encoded per machine automatically.
- OneDrive folders are reparse points; the tool stats through them.

## Report

After the pull, note: `doctor`/`adopt`/`status` output, how many sessions
landed, and whether tiles appear on reopen. Flag any project reported as
"no local folder found" (its files are missing — copy them and re-run adopt).
