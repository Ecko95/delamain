---
sketch: 002
name: signal-rack-terminal
question: "In a keyboard-driven Signal Rack, where does the peer detail view live?"
winner: "B"
tags: [layout, dashboard, peers, keyboard, terminal]
---

# Sketch 002: Signal Rack — Terminal-First

## Design Question
Refinement of sketch 001's winner. The rack is now fully keyboard-driven using the real
bindings from `src/dashboard/keybindings.ts`. The remaining question: where does the
selected peer's detail view render?

## How to View
open .planning/sketches/002-signal-rack-terminal/index.html
Click the page once, then drive entirely with the keyboard.

## Variants
- **A: Inline Expand** — ↵/space expands a detail strip under the selected row (list shifts down).
- **B: Bottom Dock** — details of the selected peer always live in a fixed bottom pane; list never shifts.
- **C: Peer Modal** — ↵ opens a centered box-drawing modal over the rack; esc closes.

## Keys (mirrors keybindings.ts)
↑/k ↓/j move · ↵/space details · c collapse group · g/G top/bottom · e jump error ·
a answer mode (input + ↵ send) · x kill mode (↵ confirm / esc cancel) · ? help overlay · q quit

## What to Look For
- Does the list shifting on expand (A) feel okay, or is a stable list with a dock (B) calmer?
- Modal (C) matches the v3 "peer modal" pattern — does it interrupt fleet-scanning too much?
- Kill-confirm and answer modes live in the status line — enough feedback, or too subtle?
- The footer keybar: keep always-visible, or hide behind `?`?
