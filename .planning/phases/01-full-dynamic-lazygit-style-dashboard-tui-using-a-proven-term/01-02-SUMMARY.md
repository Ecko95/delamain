---
phase: 01-full-dynamic-lazygit-style-dashboard-tui-using-a-proven-term
plan: 02
status: complete
completed: 2026-05-07
---

# Plan 01-02 Summary: OpenTUI Dashboard Pane Migration

## Completed

- Replaced the hand-rendered ANSI dashboard entry with a Node wrapper that launches `bun dist/dashboard/bunEntry.js`.
- Added `src/dashboard/model.ts` for pure view-model behavior: project labels, status ordering/counts, `cleanup` status, selected-index clamping, worktree warnings, details, and bounded log lines.
- Added `src/dashboard/opentui.ts` for the OpenTUI pane layout using `createCliRenderer`, `Box`, `Text`, and `ScrollBox`.
- Added bordered panes titled `Status`, `Peers`, `Details`, `Logs`, and `Keys`.
- Kept peer lifecycle actions routed through existing `listPeers()`, `readPeerLog()`, and `killPeer()`.
- Preserved `projectLabel` as an export from `dist/dashboard.js`.

## Runtime Boundary

The main package remains Node-compatible. OpenTUI imports are isolated to the Bun entrypoint so Node MCP/server/CLI imports do not load `@opentui/core`.

## Verification

- `npm run check`: passed.
- `npm test`: passed.
- Node smoke: `node dist/index.js tmux-status`, `node dist/index.js list`, and `node --input-type=module -e "await import('./dist/mcpServer.js')"` passed.
- Bun dashboard smoke: `CODEX_PEERS_DASHBOARD_SMOKE=1 node dist/index.js --d` passed and exited cleanly.
