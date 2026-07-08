---
phase: 02-signal-rack-dashboard-redesign
plan: 03
subsystem: ui
tags: [typescript, dashboard, opentui, keyboard-input, unit-tests]

# Dependency graph
requires:
  - phase: 02-signal-rack-dashboard-redesign plan 01
    provides: model.ts view-model layer (DashboardMode shape this plan converges V3 onto)
provides:
  - V3Mode union converged onto model.ts's "normal" | "kill-confirm" | "answer" | "palette" | "help" (modal/modal-answer/modal-kill retired)
  - Status-line kill-confirm (x) and answer (a) input handling in v3Input.ts, with the V5 trim/empty-reject control preserved
  - Minimal opentuiV3.ts status-line placeholder rendering so the renderer keeps compiling ahead of Plan 05's dock treatment
affects: [02-signal-rack-dashboard-redesign plan 04 (rack renderer), plan 05 (dock detail - owns the real status-line/dock rendering)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pendingPeerId replaces modalPeerId as the single target-id field shared by kill-confirm and answer modes"
    - "Text-entry branch in handleDashboardV3Input keys off state.mode === \"answer\" directly, no intermediate modal-answer state"

key-files:
  created: []
  modified:
    - src/dashboard/v3Input.ts
    - src/dashboard/opentuiV3.ts
    - tests/dashboard.test.mjs

key-decisions:
  - "Renamed modalPeerId -> pendingPeerId (and dropped modalOpenedAt/modalTab/modalButton/modalScroll entirely) since the modal machine they supported no longer exists"
  - "↵/space in normal mode now no-ops instead of opening a modal; selection already reflects on the peer row, and the bottom dock (Plan 05) will always show it"
  - "opentuiV3.ts (not in this plan's files_modified) was adjusted to keep tsc/build green: replaced the ~180-line tabbed modal box with a single-line status-line placeholder matching the sketch's kill-confirm/answer copy, marked ponytail since Plan 05 owns the real dock rendering"

patterns-established:
  - "Kill-confirm and answer share one pendingPeerId + one cancel() that always returns to normal (no more modal-answer/modal-kill nested cancel targets)"

requirements-completed: [DASH-10]

# Metrics
duration: 20min
completed: 2026-07-08
---

# Phase 02 Plan 03: Retire V3 Modal Modes for Status-Line Kill-Confirm/Answer Summary

**Converged v3Input.ts's mode union onto model.ts's `kill-confirm`/`answer` shape, retiring the modal/modal-answer/modal-kill machine and its dead tab/button/scroll state, while keeping the V5 trim + empty-reject control on answer text intact.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-08T17:52:39Z
- **Completed:** 2026-07-08T18:00:06Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- `V3Mode` is now `"normal" | "palette" | "kill-confirm" | "answer" | "help"` — no live `modal`/`modal-answer`/`modal-kill` state remains anywhere in `v3Input.ts`
- `x` on a selected peer enters `kill-confirm` (enter confirms via `killPeer`, esc cancels); `a` on a waiting peer enters `answer` (esc cancels, printable keys append, `.trim()` + empty-reject still gates `sendPeerReply`)
- Dead modal-only state (`modalTab`, `modalButton`, `modalScroll`, `modalOpenedAt`) and helpers (`openModal`, `enterModalAnswer`, `modalButtons`, `moveModalButton`, `activateModalButton`, `modalViewLog`, `modalKill`, `closeModal`) removed; palette kept per the Deprecated note
- `opentuiV3.ts` renderer updated to compile against the new `pendingPeerId`/mode names, with the old ~180-line tabbed modal box replaced by a minimal one-line status-line placeholder (`kill <id>? ↵ confirm · esc cancel` / `reply → <id>: [input]`) matching the sketch reference — full dock rendering is Plan 05's job
- 45/45 tests pass (`npx tsc -p tsconfig.json --noEmit`, `npm run build`, `node --test tests/dashboard.test.mjs` all green)

## Task Commits

Each task was committed atomically:

1. **Task 1: Retire modal modes; add status-line kill-confirm and answer modes** - `f1182a3` (feat)
2. **Task 2: Preserve answer input validation through the rework** - `d6c321b` (test)

## Files Created/Modified
- `src/dashboard/v3Input.ts` - `V3Mode`/`DashboardV3Command` unions converged onto kill-confirm/answer; `normalCommand` remaps `x`/`a`; new `openKillConfirm`/`confirmKill` helpers replace the modal machine; `submitAnswer`'s `.trim()` + empty-reject preserved; palette peer/kill/answer entries point at select/kill-confirm/answer instead of `openModal`
- `src/dashboard/opentuiV3.ts` - Adapted to `pendingPeerId` and the new mode names; replaced `modalBox`/`modalTabBody`/`modalButtonRow` with a single `statusLineBox` placeholder (ponytail-flagged, Plan 05 supersedes)
- `tests/dashboard.test.mjs` - Updated mode-name assertions (kill-confirm/answer/palette/help), added whitespace-only-reject and padded-trim tests, updated enter/space to assert no-op instead of modal-open

## Decisions Made
- Renamed `modalPeerId` → `pendingPeerId` since it is now shared, generic state for whichever status-line mode is active, not modal-specific
- Left `modalReveal` (now unused) exported and untouched in `opentuiV3.ts` rather than deleting it — it's dead but harmless, and the file isn't in this plan's declared scope; Plan 05 can remove it when it rewrites rendering
- Split test additions across the two task commits: Task 1's commit carries the mode-name/renderer rework and core transition tests; Task 2's commit isolates the two validation-specific tests (whitespace-only reject, padded-trim) to keep the "preserve V5 control" task auditable on its own

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated opentuiV3.ts to compile against the new mode/field names**
- **Found during:** Task 1
- **Issue:** The plan's `files_modified` listed only `v3Input.ts` and `tests/dashboard.test.mjs`, but `opentuiV3.ts` (the V3 OpenTUI renderer) directly referenced the retired `modalPeerId`/`modalOpenedAt`/`modalTab`/`modalButton`/`modalScroll` fields and the `"modal"`/`"modal-answer"`/`"modal-kill"` mode literals. Removing those from `v3Input.ts` broke `npx tsc --noEmit` and `npm run build`, both required by this plan's own `<verify>` step.
- **Fix:** Updated the renderer's field references to `pendingPeerId` and the new mode names, and replaced the ~180-line tabbed modal-box rendering (tabs, scrollable log, button row) with a single-line status-line placeholder that renders the sketch's kill-confirm/answer copy. Marked with a `ponytail:` comment noting Plan 05 owns the real bottom-dock rendering.
- **Files modified:** src/dashboard/opentuiV3.ts
- **Verification:** `npx tsc -p tsconfig.json --noEmit` clean, `npm run build` succeeds, full test suite green (45/45)
- **Committed in:** f1182a3 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the plan's own build/test verification green; no scope creep beyond what was required to un-break compilation. The renderer's visual detail (tabs, scrollable log, buttons) is explicitly Plan 05's responsibility per the plan objective, so this was intentionally minimized rather than fully rebuilt.

## Issues Encountered

None beyond the opentuiV3.ts coupling documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `v3Input.ts`'s `RuntimeStateV3.mode` and `pendingPeerId` now match `model.ts`'s `DashboardMode` shape, ready for Plan 05 to build the real bottom-dock status-line rendering (`kill <id>? ↵ confirm · esc cancel` / `reply → <id>: [input]`) in place of the current placeholder `statusLineBox`
- Plan 04 (rack renderer) and Plan 05 (dock detail) should expect `opentuiV3.ts` to have a temporary placeholder box for kill-confirm/answer, not the old tabbed modal — the tab/log/git detail views the old modal offered (`modalTabBody`'s INFO/LOG/GIT tabs) have no replacement yet and may need to be re-homed into the dock
- Full dashboard test suite (45 tests) passes; `npx tsc -p tsconfig.json --noEmit` is clean

---
*Phase: 02-signal-rack-dashboard-redesign*
*Completed: 2026-07-08*

## Self-Check: PASSED
