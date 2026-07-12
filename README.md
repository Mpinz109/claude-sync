# claude-sync

> Keep your Claude Code projects in sync across all your computers — the **project
> files** and the **conversation history** (transcripts, Recents tiles, project
> registration) — two-way, peer-to-peer, on Windows, macOS, and Linux.

**Status: early / work in progress.** The cross-platform engine and history
round-trip work today (verified byte-exact). The desktop GUI and Syncthing
auto-transport are in progress. See [DESIGN.md](DESIGN.md) for the architecture and
roadmap.

## Why

Claude Code stores your conversations separately from your project files, in
machine-specific locations with a few sharp edges (on Windows the data lives inside
the Store-app sandbox; session files must be UTF-8 **with no BOM** or the app
silently ignores them; transcript folders are named by an encoding of their absolute
path). Move to a new machine and your chats don't come with you. `claude-sync`
handles all of that and keeps multiple machines in sync.

## How it works

- A **vault** (a folder you share between machines) holds your sessions in a
  machine-independent form: paths are tokenized (`{{PROJECT_ROOT}}`, `{{HOME}}`) and
  everything is written BOM-free.
- **push** publishes this machine's sessions into the vault; **pull** materializes
  vault sessions into this machine's Claude (transcripts + Recents tiles +
  registration), remapping paths to local locations.
- Sync is **two-way**, union by session id. Conflicts (a session continued on two
  machines) are surfaced, not silently overwritten.
- Transport is **Syncthing** (peer-to-peer, encrypted, with crypto device IDs and
  pairing) — bundled and managed by the app, so you don't configure it. *(in progress)*
- Scheduling: a daily background **push** (safe, unattended) plus an **on-open
  pull** prompt. *(in progress)*

## Requirements

- Node.js 18+
- git (for syncing project files)
- Syncthing (bundled by the app once packaging lands)

## Install (desktop app)

Grab the installer for your OS from the [Releases](https://github.com/Mpinz109/claude-sync/releases) page:

- **Windows** — `ClaudeSync-<version>-setup.exe`
- **macOS** — `.dmg`
- **Linux** — `.AppImage`

Each bundles Node, the engine, and Syncthing, so there's nothing else to install.
(Installers are built per-OS by CI on every version tag; see `.github/workflows/build.yml`.)

## Quick start (CLI)

The engine is pure Node — no dependencies needed to run the CLI.

```bash
git clone https://github.com/Mpinz109/claude-sync
cd claude-sync

node bin/claude-sync.js doctor                 # detect your Claude install + paths
node bin/claude-sync.js init --vault <folder>  # the folder you'll share between machines
node bin/claude-sync.js link-all               # auto-link the projects on this machine
node bin/claude-sync.js push                   # publish this machine's sessions to the vault
```

On a **second computer**, point at the same vault and adopt:

```bash
node bin/claude-sync.js init --vault <the shared folder>
node bin/claude-sync.js adopt                  # link the vault's projects to local folders
# fully quit Claude, then:
node bin/claude-sync.js pull --yes
```

See [docs: second computer](LAPTOP-SETUP.md) for the full walkthrough.

## GUI

```bash
npm install     # pulls Electron
npm run app
```

A desktop app (Status / Devices / Projects / Schedule / Settings) with one-click
**Sync all projects**, **Add all detected projects**, device pairing, and the
schedule — designed to be usable without the command line.

## Safety

- Never writes a UTF-8 BOM (it breaks Claude's JSON parsing).
- Refuses to write Claude state while Claude is running.
- Additive by default; conflicts keep both sides. Back up before first use.

## Credits

The entry-level (lossless) transcript merge approach was inspired by
[perfectra1n/claude-code-sync](https://github.com/perfectra1n/claude-code-sync) (MIT),
a git-based CLI for the same problem and worth a look if you prefer that model.

## License

MIT — see [LICENSE](LICENSE).
