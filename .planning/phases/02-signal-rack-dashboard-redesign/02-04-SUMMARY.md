---
phase: 02-signal-rack-dashboard-redesign
plan: 04
subsystem: ui
tags: [typescript, dashboard, opentui, triage-grouping, context-meter]

# Dependency graph
requires:
  - phase: 02-signal-rack-dashboard-redesign plan 01
    provides: model.ts triageGroups/triageBucketForStatus/contextMeterCells/contextLevelColor view-model helpers
provides:
  - Fleet route rack rows grouped into the 5 sketch triage buckets (WORKING, WAITING, STARTING, FAILED, DONE) with group-rule headers, driven by model.ts's triageGroups instead of the old 15-status/terminal-collapse grouping
  - Inline 10-cell context-window block meter per row (level-colored, undefined-safe dim placeholder, skull blink, ⛁ compacted flag)
  - Restyled fleet header (appBar): DELAMAIN ▍FLEET orange-glow logo, per-status count chips from view.counts, teal codex 5h usage meter reusing brailleMeterLine/usageLevelColor
affects: [02-05-PLAN.md (bottom dock detail/log — shares opentuiV3.ts render surface)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "rack row column order: caret+glyph, teal id, engine chip, branch/activity, context meter, ⛁ compacted flag, right-aligned dim elapsed"
    - "context meter renders a dim placeholder (no percent) rather than a 0%/green bar when peer.contextPercent is undefined"

key-files:
  created: []
  modified:
    - src/dashboard/opentuiV3.ts

key-decisions:
  - "Retired the old 'terminal' single-line collapse (done/killed/idle folded into one strip) in favor of a real DONE bucket with its own count, matching the sketch's 5-bucket order exactly"
  - "Skull-level context meters blink via Math.floor(nowMs / 480) % 2 rather than a stateful timer, reusing the existing per-frame render tick"

patterns-established:
  - "Fleet header count chips and usage meter are derived from view.counts/view.codexUsage, not re-fetched — appBar stays a pure render of the existing view model"

requirements-completed: [DASH-09]

# Metrics
duration: 35min
completed: 2026-07-08
---

# Phase 02 Plan 04: Signal Rack Render — Triage Rows + Fleet Header Summary

**Reworked the fleet route's roster into triage-grouped dense rack rows with an inline level-colored context meter per peer, plus a restyled DELAMAIN ▍FLEET header with count chips and a codex usage meter — closing DASH-09's visible surface.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-08T20:14:09+02:00
- **Completed:** 2026-07-08T20:16:19+02:00 (approval received after)
- **Tasks:** 4 (3 auto + 1 human-verify checkpoint)
- **Files modified:** 1

## Accomplishments
- Rack rows now group peers via `triageGroups(view.peers)` into WORKING → WAITING → STARTING → FAILED → DONE, replacing the old 15-status list and its "terminal" collapse special-case, with group-rule headers and the existing `c` collapse/expand + follow-scroll preserved
- Every row carries an inline `contextMeterCells`/`contextLevelColor`-driven 10-cell block meter with a percent suffix; unmeasured peers render a dim placeholder instead of a false 0%/green bar; skull-level peers blink; compacted peers show `⛁`
- The fleet header (`appBar`) now shows the `DELAMAIN ▍FLEET` logo in accent orange with glow, per-status count chips built from `view.counts` across the 5 triage buckets, and a teal codex 5h usage meter reusing the existing `brailleMeterLine`/`usageLevelColor` helpers
- Human visual check against the `002-signal-rack-terminal` sketch mock: **approved**

## Task Commits

Each task was committed atomically:

1. **Task 1: Triage-grouped rack rows with sketch glyphs** - `42369dc` (feat)
2. **Task 2: Inline context-window block meter per row** - `cc7de00` (feat)
3. **Task 3: Fleet header — logo, count chips, codex usage meter** - `2908fc9` (feat)
4. **Task 4: Visual check — rack rows + fleet header** - checkpoint:human-verify, **approved** (no code change, no commit)

## Files Created/Modified
- `src/dashboard/opentuiV3.ts` - `STATUS_ORDER`/`STATUS_GLYPH`/`rosterLines`/`rosterPane`/`rosterLineChunks`/`appBar` reworked in place onto triage-grouped rendering, inline context meters, and the restyled fleet header

## Decisions Made
- Real DONE bucket (with count) replaces the prior single-strip terminal-status collapse, so all 5 sketch buckets are structurally equivalent instead of DONE being a special case
- No new theme colors added — header/meter treatments reuse existing `cyberpunkTheme` keys (accent orange, teal, statusColors) per the plan's "don't hand-roll" guidance

## Deviations from Plan

None - plan executed exactly as written across all 3 auto tasks; the checkpoint was approved without requested changes.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Fleet route rack + header now match the Signal Rack sketch; `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and the full `node --test tests/dashboard.test.mjs` suite (45/45) are green
- Plan 05 (bottom dock detail/log) can proceed against this rendering surface; it shares `opentuiV3.ts` but owns the dock/log/status-line area, not the rack or header touched here

---
*Phase: 02-signal-rack-dashboard-redesign*
*Completed: 2026-07-08*

## Self-Check: PASSED
