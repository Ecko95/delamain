---
name: sketch-findings-delamain
description: Validated design decisions, CSS patterns, and visual direction from sketch experiments. Auto-loaded during UI implementation on delamain.
---

<context>
## Project: delamain

Per-peer monitoring dashboard in the existing delamain cyberpunk aesthetic — dark amber base
(#100a04), orange primary (#ff7a1a), teal accent (#35e0d8), monospace/Nerd Font, CRT scanlines,
sharp corners, glow on focus. Grounded in real PeerRecord fields (status, engine codex/cursor,
model, contextPercent + contextLevel green/yellow/red/skull, compacted flag) and the real
keybindings from `src/dashboard/keybindings.ts`.

Reference point: the existing OpenTUI dashboard (`src/dashboard/opentuiV3.ts` + `theme.ts` cyberpunkTheme).

Sketch sessions wrapped: 2026-07-07
</context>

<design_direction>
## Overall Direction

**Terminal-first Signal Rack with a Bottom Dock.** One dense monospace row per peer, grouped
by status in triage order (WORKING → WAITING → STARTING → FAILED → DONE), with inline
context-window block meters colored by level. A fixed bottom dock shows the selected peer's
metadata and a scrollable, tail-following log with a position indicator. Everything is
keyboard-drivable via the existing `commandForKey()` bindings; modes (kill-confirm, answer)
render in the status line; an always-visible footer keybar reflects the focused pane.
Palette is exactly `cyberpunkTheme` — never introduce soft/rounded web-app styling.
</design_direction>

<findings_index>
## Design Areas

| Area | Reference | Key Decision |
|------|-----------|--------------|
| Layout & Density | references/layout-and-density.md | Status-grouped dense rack rows with inline ctx meters; rejected card grid and cockpit split |
| Keyboard Interaction & Detail Dock | references/keyboard-and-detail-dock.md | Bottom dock with scrollable tail-following log, tab-focus, position indicator; rejected inline expand and modal |

## Theme

The winning theme file is at `sources/themes/default.css` (CSS-variable mirror of `src/dashboard/theme.ts` cyberpunkTheme).

## Source Files

Original sketch HTML files are preserved in `sources/` for complete reference.
`sources/002-signal-rack-terminal/index.html` is the canonical interactive mock (winner B is the default view).
</findings_index>

<metadata>
## Processed Sketches

- 001-peer-monitor-layout
- 002-signal-rack-terminal
</metadata>
