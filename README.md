# claude-sync

Keep your Claude Code projects in sync across multiple computers — both the
**project files** (via git) and the **conversation history** (transcripts,
Recents tiles, project registration) — two-way, peer-to-peer via Syncthing,
on Windows, macOS, and Linux.

Born from a real migration that uncovered every quirk of how Claude stores
things: the Windows MSIX sandbox, the transcript path-encoding, and the
infamous UTF-8 BOM that makes the app silently drop sessions. Those lessons are
the foundation of this tool. See [DESIGN.md](DESIGN.md).

## Status

Early. Phase 1 (cross-platform detection) is working:

```bash
node bin/claude-sync.js doctor
```

That reports your OS, where Claude keeps transcripts / registration / Recents on
this machine, the bundled CLI location, and whether it's safe to write
(i.e. Claude is closed). Roadmap and architecture are in DESIGN.md.

## Requirements

- Node.js 18+
- (for file sync) git
- (for transport) Syncthing

## Safety

- Never writes a UTF-8 BOM (it breaks Claude's JSON parsing).
- Refuses to write Claude state while Claude is running.
- Backs up before destructive steps; conflicts keep both sides.
