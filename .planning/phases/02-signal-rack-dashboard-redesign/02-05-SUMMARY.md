---
plan: 02-05
phase: 02
title: DASH-10 render surface — sketch-locked Signal Rack
status: complete
completed_via: hands-on rebuild (operator redirect, planning skipped)
---

# 02-05 — Signal Rack render surface (sketch-locked)

## What changed vs. the original plan

Plan 02-05 was scoped to "replace `logsDrawer` + the centered modal with the
sketch-locked fixed bottom dock." During execution the operator reviewed the
running dashboard and reported it **did not look like the sketch** and asked for
a 100% match, questioning whether the app should even stay in the terminal.

Resolution (operator decisions):
- **Stay terminal.** Sketch 002 is explicitly "terminal-first" — an HTML
  *simulation* of a TUI. OpenTUI is the right tool; a web rewrite was rejected.
- **Keep routes reachable, hide chrome.** The default fleet route becomes the
  pure sketch Signal Rack; `MAP/LIMITS/UPLINK/ALERTS`, palette (`:`), and view
  digits (`1-5`) stay bound but their chrome is removed from the default view.
- **Rebuild directly, skip re-planning.**

This made 02-05 a **shell rebuild**, not just a dock swap — the mismatch was the
whole V3 shell (route tab bar, icon rail, bordered `◢ ROSTER ◤` box, right
inspector, `LIVE` badge, spinner header), none of which the sketch has.

## Delivered

- `model.ts`: threaded `engine` through `DashboardPeerRow` for the engine column.
- `opentuiV3.ts`:
  - `render()` forks — fleet route uses the sketch layout, other routes keep the
    legacy bordered shell (hidden but reachable).
  - `fleetRoster` — chromeless, full-width, borderless flat roster with
    group-rule headers; sketch column order `▶ ◉ id(8) engine(6) branch(30)
    activity(20) meter(10) NN% ⛁ elapsed(7)`, left-packed fixed columns.
  - `fleetDock` — always-visible bottom dock: `┌─ id · branch ─── log X/Y ▼ tail`
    title, `model / pid / ctx` detail line, scrollable log body.
  - `appBar` — sketch header `DELAMAIN ▍FLEET` + count chips + `codex 5h` meter;
    dropped spinner and `: palette` hint.
  - `footer` — sketch keybar; dropped the `LIVE` badge.
  - Removed the icon rail from `bodyRow`.

## Verification

- `tsc --noEmit` clean; `npm run build` OK.
- `node --test tests/*.test.mjs` → **183/183** pass.
- Rendered via smoke harness at 130×30 — confirmed header, chromeless grouped
  roster, sketch column order, bottom dock, and full keybar all match sketch 002
  variant B.

## Known terminal limits (cannot be reproduced, browser-only in the sketch)

- CSS **scanline overlay** (`body::after` repeating gradient).
- **Glow / text-shadow** on the orange/cyan/red accents.

Everything structural — palette, glyphs, block meters, box-drawing, layout,
blink — matches. Nerd Font glyph fidelity depends on the operator's terminal
font (see memory: delamain-dashboard-nerd-font).

## Commit

- `0de0ff7` feat(02-05): rebuild fleet view as sketch-locked Signal Rack
