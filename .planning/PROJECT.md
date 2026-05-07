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

- [ ] Improve the dashboard into a full dynamic TUI suitable for supervising many peers.
- [ ] Preserve peer safety and process controls while improving layout and interaction.
- [ ] Prefer proven TUI libraries over hand-rolled terminal rendering where they materially reduce complexity.

### Out of Scope

- Web dashboard — terminal-first supervision is the current product direction.
- Replacing Codex execution itself — this project supervises Codex, it does not implement a model runtime.
- Multi-user auth and hosted deployment — current scope is local developer tooling.

## Context

The codebase is TypeScript/Node ESM. Current dashboard rendering is hand-written ANSI output in `src/dashboard.ts`; it now supports selection, inline expansion, project labels, and status coloring, but it is still a custom table renderer. The next dashboard step should evaluate mature TUI frameworks before committing to a rewrite.

## Constraints

- **Runtime:** Node.js >=20 ESM package.
- **Distribution:** `codex-peers` bin should work globally via npm link/install and from any current directory.
- **Safety:** Peer worktrees, process killing, logs, and branch integration must remain inspectable.
- **Terminal UX:** Layout must remain usable in tmux/Warp and degrade cleanly on smaller terminal sizes.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Linked worktrees for peers | Keeps concurrent peer edits isolated from the source checkout | Good |
| Target branch detection plus override | Avoids hardcoded `origin/main` failures | Good |
| Source repo labels in dashboard | Generated worktree paths are not useful for supervision | Good |

---
*Last updated: 2026-05-07 after repo-local GSD initialization*
