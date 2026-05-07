# Roadmap: codex-mcp-peers-server

## Overview

The current milestone focuses on improving Codex peer supervision from a functional status table into a richer terminal control surface. Phases should preserve the existing MCP/CLI behavior while improving dashboard ergonomics and implementation maintainability.

## Phases

**Phase Numbering:**
- Integer phases are planned milestone work.
- Decimal phases are urgent insertions between existing phases.

- [ ] **Phase 1: Full dynamic lazygit-style dashboard TUI** - Replace the custom ANSI table with a polished lazygit-style dashboard built on a proven TUI library.

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
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 1 to break down)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Full dynamic lazygit-style dashboard TUI | 0/0 | Not started | - |

---
*Created: 2026-05-07*
