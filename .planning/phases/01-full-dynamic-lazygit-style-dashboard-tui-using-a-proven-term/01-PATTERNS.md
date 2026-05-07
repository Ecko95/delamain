# Phase 01 - Pattern Map

**Created:** 2026-05-07
**Scope:** OpenTUI dashboard migration planning

## Existing Patterns To Preserve

| Planned File | Role | Closest Existing Analog | Pattern To Reuse |
|--------------|------|-------------------------|------------------|
| `src/dashboard.ts` | Public dashboard entry point | `src/dashboard.ts` | Keep `startDashboard()`, `printTmuxStatus()`, and `projectLabel()` exported for current imports/tests. |
| `src/dashboard/model.ts` | Pure dashboard data derivation | current pure helpers in `src/dashboard.ts` | Preserve sorting by status rank and `updatedAt`, status counts, project labels, worktree warnings, duration formatting, and bounded log tail behavior. |
| `src/dashboard/opentui.ts` | OpenTUI renderer and component tree | current `render()` + `draw()` lifecycle in `src/dashboard.ts` | Poll `listPeers()` every 1000ms, clamp selected index, render warnings/status/detail/log information, and clean up on exit. |
| `src/dashboard/keybindings.ts` | Keyboard command mapping | current raw stdin handling in `src/dashboard.ts` | Preserve existing `j`, arrows, `enter`, `k`, `r`, `q`, `ctrl+c`; expand to focus/log/help bindings. |
| `tests/dashboard.test.mjs` | Dashboard regression coverage | `tests/git.test.mjs` | Use Node `node:test`, import from built `dist/`, and set fixture env vars where needed. |

## Current Code Excerpts

### CLI entry remains simple

`src/cli.ts` routes `dashboard`, `--d`, and `-d` through the dashboard entry in `src/index.ts`/CLI flow. The execution plan should not change command semantics.

### Current dashboard public helper

`tests/git.test.mjs` imports `projectLabel` from `../dist/dashboard.js`. Any file split must re-export this helper from `src/dashboard.ts`.

### Current lifecycle

`src/dashboard.ts` currently:
- polls peer state every 1000ms,
- hides and restores the cursor,
- handles `SIGINT` and `SIGTERM`,
- supports raw keyboard selection, expand, refresh, kill, and quit,
- uses `readPeerLog(peer.id, lines)` for bounded log tails.

The OpenTUI implementation should move terminal mode ownership to `createCliRenderer()` and `renderer.destroy()` while preserving the same product behaviors.

## Recommended Data Flow

```text
listPeers()
  -> createDashboardViewModel(peers, state, now)
  -> renderDashboard(renderer, viewModel)
  -> key command updates DashboardState
  -> optional peer action through killPeer()
  -> next poll/redraw
```

## File Split Guidance

- Keep `src/dashboard.ts` small. It should orchestrate imports and expose public functions.
- Put pure logic in `src/dashboard/model.ts` so tests can validate behavior without TTY/OpenTUI.
- Put all OpenTUI imports in `src/dashboard/opentui.ts` to isolate runtime risk and fallback work.
- Put key mapping in `src/dashboard/keybindings.ts` so command coverage is testable without a renderer.

## Non-Goals

- Do not duplicate peer lifecycle or worktree logic from `src/peerManager.ts`.
- Do not add browser UI dependencies.
- Do not implement mouse, filtering/search, or theme configuration in Phase 1.

## PATTERN MAPPING COMPLETE
