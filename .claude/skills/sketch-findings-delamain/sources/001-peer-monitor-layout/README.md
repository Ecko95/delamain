---
sketch: 001
name: peer-monitor-layout
question: "What layout structure feels right for monitoring individual peers?"
winner: "A"
tags: [layout, dashboard, peers, cyberpunk]
---

# Sketch 001: Peer Monitor Layout

## Design Question
What layout structure feels right for a per-peer monitoring dashboard using the existing
cyberpunk theme (`src/dashboard/theme.ts` cyberpunkTheme)?

## How to View
open .planning/sketches/001-peer-monitor-layout/index.html

## Variants
- **A: Signal Rack** — dense status-grouped rows (closest to the current TUI); click a row to expand an inline detail strip.
- **B: Peer Card Grid** — one card per peer with context gauge, token sparkline, log tail, and REPLY/INTEGRATE/KILL actions.
- **C: Cockpit Split** — roster on the left, deep single-peer view on the right: fleet stage tracker (SPAWN→WORK→WAIT→INTEGRATE→DONE), telemetry tiles, live log stream.

## What to Look For
- Which density fits how you actually watch a fleet: scan everything (A), triage at a glance (B), or focus one peer (C)?
- Context-window telemetry treatment: inline bar (A), gauge row (B), big tile with level color (C).
- The `⚡ simulate event` button in the nav flips the waiting peer to working / climbs a peer's context — watch how each layout communicates the change.
- Whether the compacted flag (⛁) and skull-level context read as urgent enough.
