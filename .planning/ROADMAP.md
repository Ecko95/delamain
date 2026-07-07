# Roadmap: codex-mcp-peers-server

## Overview

The current milestone focuses on improving Codex peer supervision from a functional status table into a richer terminal control surface. Phases should preserve the existing MCP/CLI behavior while improving dashboard ergonomics and implementation maintainability.

## Phases

**Phase Numbering:**

- Integer phases are planned milestone work.
- Decimal phases are urgent insertions between existing phases.

- [x] **Phase 1: Full dynamic lazygit-style dashboard TUI** - Replace the custom ANSI table with a polished lazygit-style dashboard built on a proven TUI library.
- [ ] **Phase 2: Signal Rack dashboard redesign** - Rework the OpenTUI dashboard into the sketch-locked Signal Rack layout with a bottom detail dock.

## Phase Details

### Phase 1: Full dynamic lazygit-style dashboard TUI using a proven terminal UI library

**Goal:** Deliver a full dynamic terminal dashboard with a lazygit-style grid layout, bordered panes, color, keyboard navigation, responsive resizing, and richer peer visibility.
**Requirements**: DASH-04, DASH-05
**Depends on:** Nothing (first repo-local planned phase)
**Success Criteria** (what must be TRUE):

  1. User can run `codex-peers --d` and see a pane-based dashboard rather than a hand-rendered table.
  2. Dashboard shows peer list, selected peer details, recent logs, and status/summary panes in a responsive grid.
  3. Keyboard navigation supports moving focus, expanding details, scrolling logs, refreshing, killing peers, and quitting without layout glitches.
  4. Implementation uses a vetted TUI library or records a clear rationale if a small custom layer remains necessary.
  5. Existing MCP, CLI, process supervision, worktree safety, and branch integration behavior continue to pass tests.

**Plans:** 3/3 plans executed. OpenTUI dashboard uses a Bun-backed runtime while Node remains supported for MCP/server/non-dashboard CLI behavior.

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Prove and record the OpenTUI runtime/dependency path before migrating the dashboard. Decision: use Bun for the OpenTUI dashboard path because Node import fails on OpenTUI `.scm` assets.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Migrate the current hand-rendered ANSI dashboard into an OpenTUI pane architecture while preserving existing peer data semantics.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Complete dashboard interactions, smoke checks, and user-facing key documentation.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Full dynamic lazygit-style dashboard TUI | 3/3 | Complete | 2026-05-07 |
| 2. Signal Rack dashboard redesign | 0/? | Pending | — |

### Phase 2: Signal Rack dashboard redesign

**Goal:** Rework the OpenTUI operator dashboard (`src/dashboard/opentuiV3.ts`) into the sketch-locked "Signal Rack" layout — status-grouped dense monospace peer rows with inline context-window block meters, a fixed bottom detail dock with a scrollable tail-following log, and the exact `cyberpunkTheme` — fully keyboard-drivable via the existing `keybindings.ts` bindings.
**Requirements**: DASH-09, DASH-10
**Depends on:** Phase 1
**Success Criteria** (what must be TRUE):

  1. Peers render grouped by status in triage order (WORKING → WAITING → STARTING → FAILED → DONE), one dense monospace row each, with inline context-window block meters colored by `contextLevel` (green/yellow/red/skull) and a `⛁` flag when compacted.
  2. A fleet header shows per-status count chips and a codex usage meter; a footer keybar reflects the currently focused pane.
  3. A fixed bottom dock shows the selected peer's detail plus a scrollable log that follows the tail, with a `log N/M ▼ tail / ▲ scrolled` position indicator; changing selection re-attaches the tail and `b` jumps to tail.
  4. Tab moves focus between the rack and the dock; the focused pane is glow-highlighted (teal); kill-confirm and answer modes render in the status line.
  5. Palette exactly matches `cyberpunkTheme` (teal ids, orange primary, purple cursor-engine chips, CRT scanlines, glow, sharp corners) — no rounded/soft web-app styling.
  6. Existing MCP, CLI, and peer supervision behavior continue to pass tests.

**Design source:** `.claude/skills/sketch-findings-delamain/` (winners: 001 Signal Rack layout, 002 Bottom Dock) — sketches wrapped 2026-07-07.
**Plans:** 0 plans

Plans:

- [ ] TBD (run /gsd-plan-phase 2 to break down)
