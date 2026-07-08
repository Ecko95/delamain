---
phase: 02-signal-rack-dashboard-redesign
plan: 02
subsystem: ui
tags: [opentui, typescript, tui, scrollbox]

# Dependency graph
requires:
  - phase: 02-signal-rack-dashboard-redesign (plan 01)
    provides: opentuiV3.ts baseline and existing Box()/Text() factory usage patterns
provides:
  - Confirmed ScrollBox factory export shape in @opentui/core@0.2.4, unblocking Plan 05's dock log design
affects: [02-signal-rack-dashboard-redesign plan 05 (dock)]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: [src/dashboard/scrollBoxProbe.ts]
  modified: []

key-decisions:
  - "VERDICT: FACTORY — ScrollBox is exported identically to Box/Text: `function ScrollBox(props, ...children) { return h(ScrollBoxRenderable, props || {}, ...children); }` (node_modules/@opentui/core/index-4w8751xf.js:3238). Plan 05 must use `ScrollBox({ stickyScroll: true, stickyStart: \"bottom\", scrollY: true, ...opts }, ...children)` inline in the render tree, exactly like existing Box()/Text() calls."

requirements-completed: [DASH-10]

# Metrics
duration: 5min
completed: 2026-07-08
---

# Phase 02 Plan 02: ScrollBox Export Shape Spike Summary

**Confirmed `ScrollBox` in `@opentui/core@0.2.4` is a factory function matching `Box()`/`Text()` usage, unblocking Plan 05's dock log design on the library primitive instead of hand-rolled scroll math.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-08T17:47:35Z
- **Completed:** 2026-07-08T17:49:06Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Grepped the compiled `@opentui/core` bundle (`index-4w8751xf.js`) and found `ScrollBox` defined identically to `Box`: `function ScrollBox(props, ...children) { return h(ScrollBoxRenderable, props || {}, ...children); }`
- Wrote a type-checked probe (`src/dashboard/scrollBoxProbe.ts`) calling `ScrollBox({ stickyScroll: true, stickyStart: "bottom", scrollY: true, height: 5, width: "100%" }, Text({ content: "x" }))` — `npx tsc -p tsconfig.json --noEmit` passes clean
- Resolved 02-RESEARCH.md Open Question 2 / Assumption A3 with certainty (no longer "unconfirmed")

## Task Commits

1. **Task 1: Probe the ScrollBox export shape and record the decision** - `266ca61` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/dashboard/scrollBoxProbe.ts` - Throwaway type-check-only probe proving `ScrollBox` factory call shape; not imported by any shipped module. Kept in place (not deleted) as a compile-only reference per the plan's option; safe to delete once Plan 05 lands the real dock usage.

## Decisions Made
**VERDICT: FACTORY** — Plan 05 uses `ScrollBox({...opts}, ...children)` inline in the render tree, the same composition style as `Box()`/`Text()` already used throughout `opentuiV3.ts`. No `new ScrollBoxRenderable(ctx, options)` construction path is needed.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 05's dock log implementation can proceed directly with `ScrollBox({ stickyScroll: true, stickyStart: "bottom", scrollY: true, height: dockLogHeight, width: "100%" }, ...logLineRenderables)`, deleting the hand-rolled `visibleLogContent`/`withScrollbar`/`logProgressLine` math as originally recommended in 02-RESEARCH.md Pattern 3. No blockers.

---
*Phase: 02-signal-rack-dashboard-redesign*
*Completed: 2026-07-08*

## Self-Check: PASSED
