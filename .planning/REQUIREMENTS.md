# Requirements: codex-mcp-peers-server

**Defined:** 2026-05-07
**Core Value:** Run multiple Codex peer jobs safely and visibly without losing track of repo, branch, worktree, process, and task context.

## v1 Requirements

### Peer Supervision

- [x] **PEER-01**: User can spawn a supervised Codex peer from MCP.
- [x] **PEER-02**: User can spawn, inspect, resume, and kill peers from the CLI.
- [x] **PEER-03**: Peer state includes status, process ids, log path, task, question, and final result.

### Worktree Safety

- [x] **WT-01**: New peers run in isolated linked worktrees.
- [x] **WT-02**: Successful peer work is committed and integrated back to the target origin branch.
- [x] **WT-03**: Repositories whose default branch is not `main` are supported.

### Dashboard

- [x] **DASH-01**: User can view live peer status in a terminal dashboard.
- [x] **DASH-02**: Dashboard shows meaningful source repo labels instead of generated worktree ids.
- [x] **DASH-03**: Dashboard can expand a peer to show detail and recent log context.
- [x] **DASH-04**: Dashboard provides a full dynamic lazygit-style grid UI with bordered panes, color, keyboard navigation, and responsive layout.
- [x] **DASH-05**: Dashboard implementation uses a proven TUI library unless evaluation shows the dependency is unsuitable.

## v2 Requirements

### Advanced Dashboard

- **DASH-06**: Mouse support for pane selection and scrolling.
- **DASH-07**: Filtering and search across peer tasks, repos, statuses, and logs.
- **DASH-08**: Theme configuration for light/dark/high-contrast terminal palettes.

### Signal Rack Redesign

- **DASH-09**: Dashboard renders peers as status-grouped dense monospace rows (triage order WORKING → WAITING → STARTING → FAILED → DONE) with inline context-window block meters colored by contextLevel, plus a fleet header with status count chips and a codex usage meter.
- **DASH-10**: Selecting a peer shows its detail and a scrollable, tail-following log in a fixed bottom dock with a `log N/M ▼ tail / ▲ scrolled` position indicator; Tab moves focus between rack and dock, and the focused pane is glow-highlighted with a footer keybar that reflects it.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Browser dashboard | Current product is terminal-first and should work in tmux/Warp |
| Hosted peer service | Local developer supervision is the current deployment model |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PEER-01 | Existing | Complete |
| PEER-02 | Existing | Complete |
| PEER-03 | Existing | Complete |
| WT-01 | Existing | Complete |
| WT-02 | Existing | Complete |
| WT-03 | Existing | Complete |
| DASH-01 | Existing | Complete |
| DASH-02 | Existing | Complete |
| DASH-03 | Existing | Complete |
| DASH-04 | Phase 1 | Complete |
| DASH-05 | Phase 1 | Complete |
| DASH-09 | Phase 2 | Complete |
| DASH-10 | Phase 2 | Pending |

**Coverage:**

- v1 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0

---
*Requirements defined: 2026-05-07*
*Last updated: 2026-07-07 — added DASH-09/DASH-10 for Signal Rack redesign (Phase 2)*
