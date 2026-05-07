# codex-mcp-peers-server

## What This Is

`codex-mcp-peers-server` is an MCP server and CLI for spawning, supervising, and reviewing headless Codex peer workers across repositories. It provides linked worktree isolation, peer lifecycle control, log access, integration back to the target branch, and a live terminal dashboard.

## Core Value

Run multiple Codex peer jobs safely and visibly without losing track of which repo, branch, worktree, process, and task each peer is working on.

## Requirements

### Validated

- [x] Spawn peer jobs through MCP and CLI.
- [x] Run peers in isolated linked worktrees.
- [x] Track peer status, logs, questions, and integration results.
- [x] Support non-`main` origin default branches and explicit target branches.
- [x] Provide a terminal dashboard and tmux status line.

### Active

- [x] Improve the dashboard into a full dynamic TUI suitable for supervising many peers.
- [x] Preserve peer safety and process controls while improving layout and interaction.
- [x] Prefer proven TUI libraries over hand-rolled terminal rendering where they materially reduce complexity.

### Out of Scope

- Web dashboard — terminal-first supervision is the current product direction.
- Replacing Codex execution itself — this project supervises Codex, it does not implement a model runtime.
- Multi-user auth and hosted deployment — current scope is local developer tooling.

## Context

The codebase is TypeScript/Node ESM for MCP/server/non-dashboard CLI behavior. Dashboard commands launch a Bun-backed OpenTUI runtime because `@opentui/core@0.2.4` fails under Node ESM while importing bundled `.scm` assets. The dashboard rendering is split into a Node wrapper, pure model/keybinding modules, and a Bun-only OpenTUI pane renderer.

## Constraints

- **Runtime:** Node.js >=20 ESM package, with Bun required only for OpenTUI dashboard commands.
- **Distribution:** `codex-peers` bin should work globally via npm link/install and from any current directory.
- **Safety:** Peer worktrees, process killing, logs, and branch integration must remain inspectable.
- **Terminal UX:** Layout must remain usable in tmux/Warp and degrade cleanly on smaller terminal sizes.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Linked worktrees for peers | Keeps concurrent peer edits isolated from the source checkout | Good |
| Target branch detection plus override | Avoids hardcoded `origin/main` failures | Good |
| Source repo labels in dashboard | Generated worktree paths are not useful for supervision | Good |
| Bun-backed OpenTUI dashboard path | Keeps OpenTUI despite Node `.scm` import failure while preserving Node for MCP/server CLI behavior | Accepted |

---
*Last updated: 2026-05-07 after repo-local GSD initialization*
