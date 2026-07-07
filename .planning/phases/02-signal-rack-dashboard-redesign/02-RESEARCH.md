# Phase 2: Signal Rack Dashboard Redesign - Research

**Researched:** 2026-07-07
**Domain:** OpenTUI terminal rendering (Bun runtime), TypeScript state machines
**Confidence:** HIGH (grounded entirely in real source read this session; no external library research needed beyond OpenTUI's own type declarations)

## Summary

The current `opentuiV3.ts` (1418 lines) implements an "operator deck" architecture — icon rail, route-switching (fleet/map/limits/uplink/alerts), a roster pane, an optional wide inspector pane, a collapsible bottom logs *drawer*, and a **centered modal** for peer detail/kill/answer. The Signal Rack spec in the sketch skill wants a materially different shape: a single always-visible status-grouped rack (no route-switching for the primary view), inline per-row context-window meters, and peer detail/kill/answer folded into a **fixed bottom dock** (not a modal) with a tail-following scrollable log and a position indicator. There is no card-flip here — this is a genuine rework of `mainArea`/`bodyRow`/`logsDrawer`/`modalBox`, not a coat of paint.

Two real landmines were found by reading the code (not assumed): (1) `keybindings.ts`'s `commandForKey()` — which the phase brief calls "the real keybindings" — is **dead code as far as V3 is concerned**; it's only wired into V2 (`v2Input.ts`). V3 has its own parallel `v3CommandForKey()` in `v3Input.ts` with different semantics (e.g., `x`/`a` open a modal rather than a direct kill-confirm/answer status-line mode). The planner must decide which is the "existing keybindings" contract for DASH-10 — recommendation below. (2) `contextPercent`/`contextLevel`/`compacted` already exist on `PeerRecord` (computed by `codexContext.ts`) but are **not yet plumbed into `DashboardPeerRow` or any renderer** — the block meter is new code end-to-end, not a restyle.

**Primary recommendation:** Rework `opentuiV3.ts` in place (do not fork a V4). Keep `bunEntryV2.ts`'s `DELAMAIN_DASHBOARD=v2` escape hatch for V2 untouched. Migrate V3's kill/answer flow off the centered modal and onto direct status-line modes (matching the sketch, and incidentally converging V3 back toward `keybindings.ts`'s original `kill-confirm`/`answer` mode names). Use OpenTUI's built-in `ScrollBoxRenderable` (`stickyScroll`, `stickyStart: "bottom"`, `scrollTop`/`scrollHeight`) for the dock log instead of the hand-rolled offset math currently in `logsDrawer`/`visibleLogContent`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Peer status grouping/sort (triage order) | Render/view-model (`model.ts` + `opentuiV3.ts`) | — | Pure data transform, no I/O; belongs next to existing `dashboardPeers`/`statusRank` |
| Context-window block meter | View-model (`model.ts`) computes cells+color; render (`opentuiV3.ts`) draws glyphs | `codexContext.ts` (data source, already built) | Data already computed upstream; only the presentation layer is new |
| Bottom dock (detail + log) | Render (`opentuiV3.ts`), state in `v3Input.ts` | OpenTUI `ScrollBoxRenderable` (log scroll mechanics) | Focus/scroll state belongs in `RuntimeStateV3`; scroll physics should be delegated to the library primitive instead of hand-rolled |
| Tab focus cycling (rack ↔ dock) | Input/state (`v3Input.ts`) | Render (border/glow color swap) | Already has a precedent: `drawerFocused` toggle exists, just needs remapping to two panes instead of drawer+main |
| Kill-confirm / answer modes | Input/state (`v3Input.ts`) | Render status line (`opentuiV3.ts`) | `model.ts`'s `DashboardMode` ("normal"\|"kill-confirm"\|"answer"\|"help") and `messageForState()` already model this correctly — V3 just doesn't use them yet |
| Fleet header (counts + usage meter) | Render (`opentuiV3.ts`) | `codexUsage.ts` (already wired via `codexUsageProvider`) | `appBar()` already renders count chips; only needs restyling + moving the usage meter into it |
| MCP/CLI/peer supervision | Node process (`peerManager.ts`, `src/index.ts`) | — | Out of scope for this phase; must not regress (Success Criterion 6) |

## User Constraints

No `CONTEXT.md` exists for this phase (confirmed: `.planning/phases/02-signal-rack-dashboard-redesign/` contains only `.gitkeep`). The locked design contract is the `sketch-findings-delamain` skill instead — treat every decision in `layout-and-density.md` and `keyboard-and-detail-dock.md` as if it were a CONTEXT.md `## Decisions` entry. Nothing is "Claude's discretion" except where those documents are silent (e.g., exact block-meter cell count, exact fleet-header wording) — for those, prefer minimal change from the existing `opentuiV3.ts` conventions (e.g., existing braille-meter pattern in `limitsContent`/`brailleMeterLine` for style consistency, though the sketch specifies a 10-cell block meter `████░░░░░░`, which is a different glyph set and must be followed literally since it's explicitly specified).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DASH-09 | Status-grouped dense monospace rows (triage order), inline context-window block meters colored by contextLevel, fleet header with count chips + codex usage meter | `rosterLines()`/`rosterPane()`/`appBar()` in `opentuiV3.ts` are the direct rework targets; `contextPercent`/`contextLevel`/`compacted` already exist on `PeerRecord` (`src/types.ts:92-94`) via `codexContext.ts`, just unplumbed into `DashboardPeerRow` |
| DASH-10 | Fixed bottom dock with tail-following scrollable log + position indicator; Tab focus cycling with glow; footer keybar reflects focus | `logsDrawer()`/`modalBox()` are the rework targets; OpenTUI's `ScrollBoxRenderable` (`stickyScroll`/`stickyStart: "bottom"`/`scrollTop`/`scrollHeight`) directly supports tail-follow without hand-rolled offset math; `RuntimeStateV3.drawerFocused` is the existing focus-toggle precedent |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@opentui/core` | 0.2.4 (pinned, installed) [VERIFIED: package.json + node_modules] | TUI renderer, layout (Yoga flexbox), styled text | Already the chosen library from Phase 1 — no alternative should be introduced |
| Bun | 1.3.13 (installed on this machine) [VERIFIED: `bun --version`] | Runtime for the dashboard entry only | Required because `@opentui/core@0.2.4` fails under Node ESM loading bundled `.scm` assets (documented in `bunMissingMessage()` and `.planning/STATE.md`) |

No new packages are needed for this phase — everything required (grouping, meters, dock, scroll) is buildable with primitives already present in `@opentui/core` and the existing TypeScript files. **Package Legitimacy Audit is not applicable** — zero new dependencies.

### Supporting (already in the codebase, reused)
| Module | Purpose | When to Use |
|--------|---------|-------------|
| `src/codexContext.ts` | Computes `contextPercent`/`contextLevel`/`compacted` from a peer's session JSONL | Read-only data source for the new block meter; do not reimplement threshold logic (green ≥0 <70, yellow ≥70 <85, red ≥85 <95, skull ≥95 — see `contextLevel()`) |
| `src/dashboard/logEvents.ts` (`LogBuffer`) | Tails a peer's log file incrementally, parses structured Codex JSONL into `LogEvent[]` | Already wired into `opentuiV3.ts`'s `refresh()`; keep as-is, only the *rendering* of `view.logLines` changes |
| `@opentui/core` `ScrollBoxRenderable` | Native scrollable container with sticky-bottom support | Use for the dock's log body instead of `visibleLogContent()`/`withScrollbar()`'s manual math |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tail-following scroll + position indicator | Custom `logOffset`/`visibleLogContent`/`withScrollbar` math (current V3 approach) | `ScrollBoxRenderable` with `stickyScroll: true, stickyStart: "bottom"`, reading `scrollTop`/`scrollHeight`/`content` height for the `N/M` indicator | The library already implements exactly the "stick to bottom unless user scrolls up" behavior the sketch describes; hand-rolled math (current code) is more lines and already has subtle bugs (e.g., `jump(state,"top")` sets `logOffset = Number.MAX_SAFE_INTEGER` which is clamped elsewhere — fragile) |
| Focus glow / border highlight | New focus-tracking system | Existing `theme.borderFocused` (`#35e0d8`) + `state.drawerFocused`-style boolean per pane (rename/generalize to a two-value `focusPane: "rack" \| "dock"`) | `theme.ts` already defines the exact teal glow color; `opentuiV3.ts` already conditionally sets `borderColor: state.drawerFocused ? theme.borderFocused : theme.border` in `logsDrawer()` — same pattern, just needs to also apply to the rack pane |
| Block-meter glyph rendering | A new charset/graphics library | Plain string built from `"█".repeat(filled) + "░".repeat(10-filled)"` | 10-cell filled/empty block meter is literally specified in the sketch (`████░░░░░░ 42%`) — no library needed, it's a one-line string builder |
| Status counts/usage meter | New aggregation logic | Existing `view.counts` (from `countByDashboardStatus`) and `view.codexUsage` (already read via `codexUsageProvider`) | Both already computed in the current `refresh()`/`createDashboardViewModel()` pipeline; `appBar()` already partially renders counts — extend, don't rebuild |

**Key insight:** Every "new" capability in this phase (grouping, meters, dock, focus) has an 80%-built precedent already sitting in `opentuiV3.ts`/`model.ts`/`v3Input.ts`. This is a rework-in-place phase, not a greenfield build — the risk is losing existing correct behavior (peer selection clamping, log tailing, toast system, palette) while restyling, not inventing new algorithms.

## Architecture Patterns

### System Architecture Diagram

```
PeerRecord[] (peerManager.listPeers())
        │
        ▼
createDashboardViewModel()  ← model.ts
  - sorts/groups by dashboardStatus() + statusRank()
  - NEW: must also expose contextPercent/contextLevel/compacted per row
        │
        ▼
DashboardViewModel { peers[], counts, codexUsage, logLines, logEvents, ... }
        │
        ▼
render(renderer, view, state, nowMs, supervisor)   ← opentuiV3.ts
        │
        ├─ appBar()          → NEW: fleet header w/ status chips + codex usage meter (restyle existing)
        ├─ rackPane()         → REWORK of rosterPane(): status-grouped rows, ▶ caret, block meter, ⛁ flag
        ├─ dockPane()          → REWORK of logsDrawer()+modalBox(): fixed-height, peer detail + ScrollBox log
        ├─ statusLine()        → NEW: kill-confirm / answer modes rendered inline (currently only in modalBox)
        └─ footer()            → REWORK: keybar text reflects state.focusPane ("rack" | "dock")
        │
        ▼
renderer.requestRender()

Input path:
keypress → handleDashboardV3Input(sequence, state, actions) → v3CommandForKey() → state mutation → refresh()
```

A reader can trace: peer data enters at `listPeers()` → transformed once in `createDashboardViewModel` → consumed once in `render()`. Grouping/sorting must happen in `model.ts` (view-model layer) so it's testable without a real terminal (matches the existing `tests/dashboard.test.mjs` pattern of testing `createDashboardViewModel` directly).

### Recommended Project Structure (no new files needed)
```
src/dashboard/
├── model.ts       # ADD: DashboardPeerRow.contextPercent/contextLevel/compacted; ADD: status-group-with-triage-order helper (parallel to existing dashboardPeers/statusRank)
├── opentuiV3.ts    # REWORK: rosterPane→rack, logsDrawer+modalBox→dock, appBar restyle, footer restyle
├── v3Input.ts      # REWORK: replace modal-open flow for kill/answer with direct mode set (mirroring model.ts's DashboardMode); generalize drawerFocused→focusPane
├── theme.ts        # UNCHANGED — cyberpunkTheme already has every color the sketch needs (accent teal, danger red, statusColors)
├── keybindings.ts  # DECISION NEEDED (see Open Questions) — likely left as V2-only, OR reconciled with v3Input's key map
└── logEvents.ts    # UNCHANGED — LogBuffer/parseLogChunk already produce what the dock needs
```

### Pattern 1: Status-grouped triage rendering
**What:** Group visible peer rows by status bucket, iterate buckets in a fixed triage order, render a group-header rule line, then peer rows.
**When to use:** Rack pane body.
**Example (existing precedent, restyle not rewrite):**
```typescript
// Source: src/dashboard/opentuiV3.ts:469-492 (rosterLines) — ALREADY implements this pattern for
// STATUS_ORDER; the sketch's triage order (WORKING → WAITING → STARTING → FAILED → DONE) is a
// *different* order than the current STATUS_ORDER array (opentuiV3.ts:40-56), so STATUS_ORDER
// itself needs reordering/rebuilding, not the grouping algorithm.
const STATUS_ORDER: DashboardStatus[] = ["working", "waiting", "starting", "failed", "done", /* ...rest */];
```
**Landmine:** Current `STATUS_ORDER` starts `working, waiting, cleanup, gsd_running_phase, ...` and buckets `done/killed/gsd_completed/idle/gsd_pending` into a single collapsed "terminal" strip rather than a `DONE` group with count. The sketch's 5-bucket order (`WORKING → WAITING → STARTING → FAILED → DONE`) is coarser — GSD-specific statuses (`gsd_running_phase`, `gsd_polling_state`, etc.) need a mapping decision: fold into the nearest of the 5 buckets (recommended: working-like → WORKING, halted/failed-like → FAILED, completed-like → DONE) rather than inventing new buckets, since the sketch and REQUIREMENTS.md (DASH-09) only name 5 statuses.

### Pattern 2: Block meter with color-by-level
**What:** 10-cell filled/empty bar colored by `contextLevel`, percent suffix, skull blink when critical.
**When to use:** Inline in each peer row (rack) and in dock detail.
**Example (new code, following the sketch spec + existing blink pattern from `focusSweepBg`/toast animations for timing):**
```typescript
// Source: sketch layout-and-density.md line 8 (spec) + existing blink precedent at
// opentuiV3.ts:350 (`Math.floor(nowMs / 480) % 2 === 0`) for the alert-tab blink
function contextMeter(percent: number, level: CodexContextLevel, nowMs: number): string {
  const filled = Math.round((percent / 100) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const blinking = level === "skull" && Math.floor(nowMs / 480) % 2 === 0;
  return blinking ? " ".repeat(bar.length) : bar; // blink = alternate bar/blank, color applied by caller via textColor()
}
const LEVEL_COLOR: Record<CodexContextLevel, string> = {
  green: cyberpunkTheme.statusColors.starting, // #35e0d8 per sketch ("green #35e0d8" — NOTE: sketch's
  // "green" label is actually cyberpunkTheme's teal accent, not a literal green hex; verify against
  // sources/themes/default.css before implementing, see Open Questions.
  yellow: "#ffb066",
  red: "#ff7a1a",
  skull: "#ff4433",
};
```

### Pattern 3: Fixed bottom dock with ScrollBox tail-follow
**What:** Replace `logsDrawer()`'s hand-rolled `visibleLogContent`/`withScrollbar` with `ScrollBoxRenderable`.
**When to use:** Dock's log body.
**Example:**
```typescript
// Source: node_modules/@opentui/core/renderables/ScrollBox.d.ts (ScrollBoxOptions, ScrollBoxRenderable)
import { ScrollBox } from "@opentui/core"; // exported from renderables/index via top-level index.d.ts
ScrollBox(
  {
    stickyScroll: true,
    stickyStart: "bottom",   // re-attaches to tail automatically unless user has scrolled
    scrollY: true,
    height: dockLogHeight,
    width: "100%",
  },
  ...logLineRenderables, // one Text() per formatted log line
);
// Position indicator: read scrollBoxRef.scrollTop / scrollBoxRef.scrollHeight after render
// to compute "log N/M ▼ tail" vs "log N/M ▲ scrolled" — NOT string-math like current logProgressLine().
```
**Caveat (flagged, not verified):** The `.d.ts` confirms the API surface (`stickyScroll`, `stickyStart`, `scrollTop`, `scrollHeight`, `scrollTo`, `scrollBy`) exists in the installed `@opentui/core@0.2.4`, but this session did not run a live render to confirm `ScrollBox()` is exported as a JSX-style factory function the same way `Box()`/`Text()` are (only the class `ScrollBoxRenderable` and interface were read from the `.d.ts`; the factory-function export needs a quick grep of the compiled `.js` before relying on it in a plan). See Open Questions.

### Anti-Patterns to Avoid
- **Reintroducing the centered modal for peer detail/kill/answer:** the sketch explicitly rejects this ("Centered peer modal (002 C) — obscures the fleet"). `modalBox()`/`modalTabBody()`/`modalButtonRow()` (~300 lines) should be deleted, not kept behind a flag — Success Criterion 3/4 require the *bottom dock*, not an additional UI mode.
- **Route-switching the primary view:** current V3 has 5 routes (fleet/map/limits/uplink/alerts) via digit keys. The sketch's rack is a single always-visible view. Recommend keeping MAP/LIMITS/UPLINK/ALERTS as secondary routes reachable via existing `1`-`5` keys (out of explicit scope, and DASH-09/10 don't mention removing them) but make **route "fleet" the rack+dock layout** — do not silently drop the other routes without user sign-off, since ROADMAP.md's success criteria don't mention them either way (see Open Questions).
- **Inventing new status buckets for GSD statuses:** stick to the 5 named buckets; anything else contradicts DASH-09's literal wording.

## Common Pitfalls

### Pitfall 1: Treating `keybindings.ts` as V3's live key map
**What goes wrong:** A plan that says "wire the new dock focus into `commandForKey()`" will silently do nothing, because `opentuiV3.ts` never calls `commandForKey()` — it calls `v3CommandForKey()` from `v3Input.ts`, a completely separate switch statement.
**Why it happens:** `keybindings.ts` is real, tested (`tests/dashboard.test.mjs` line ~22), and *is* used — just only by V2 (`opentuiV2.ts`/`v2Input.ts`), which is still reachable via `DELAMAIN_DASHBOARD=v2`.
**How to avoid:** All key-handling changes for this phase go in `v3Input.ts`'s `v3CommandForKey`/`handleDashboardV3Input`/`RuntimeStateV3`, never in `keybindings.ts`.
**Warning signs:** Any plan task referencing `commandForKey(` inside a file that imports from `./v3Input.js` rather than `./keybindings.js`.

### Pitfall 2: Modal-based kill/answer contradicts DASH-10's status-line requirement
**What goes wrong:** DASH-10 and the sketch both say kill-confirm/answer render "in the status line." Current V3 requires opening the peer modal first (`x`/`a` → `openModal`/`openAnswer`, both of which set `state.mode = "modal"` or `"modal-kill"`/`"modal-answer"`, all rendered by `modalBox()`). If the plan just "restyles" the modal to look dock-like, it will still be a floating overlay, not a status line.
**Why it happens:** `model.ts` already has the *correct* target shape (`DashboardMode = "normal" | "kill-confirm" | "answer" | "help"` and `messageForState()`), but `v3Input.ts`/`opentuiV3.ts` diverged from it when V3 was built and invented `modal`/`modal-answer`/`modal-kill`/`palette` instead.
**How to avoid:** Plan tasks should explicitly retire `modal`/`modal-answer`/`modal-kill` from `V3Mode` and replace with the `model.ts`-shaped `kill-confirm`/`answer`, rendering the result in a new `statusLine()` function above the footer (matching the sketch's `.statusline` element), not in a bordered popup.
**Warning signs:** Any new code still keyed off `state.mode === "modal"`.

### Pitfall 3: `contextPercent`/`contextLevel`/`compacted` are optional and often `undefined`
**What goes wrong:** These fields are only populated once a peer has emitted at least one `token_count` event (`readPeerContext`/`contextFromSession` in `codexContext.ts`) and only for the `codex` engine (Cursor peers won't have them — confirm via `peer.engine`/`kind` before assuming presence). A block meter that assumes the field is always a number will render `NaN%`/empty bars for early-lifecycle or cursor peers.
**Why it happens:** The field is populated by a separate polling/read path, not guaranteed to exist at spawn time (per the comment in `types.ts`: "Absent until the first token_count event is seen").
**How to avoid:** Render nothing (or a dim placeholder, e.g. `──────────` with no percent) when `contextPercent === undefined`, rather than defaulting to 0%/green which would misrepresent an unmeasured peer as "safe."
**Warning signs:** Any code doing `peer.contextPercent ?? 0` without also branching on `undefined` for the *display* (defaulting the number for math is fine; defaulting the display would lie).

### Pitfall 4: `DashboardPeerRow` doesn't currently carry these fields — must be threaded through `createDashboardViewModel`
**What goes wrong:** `dashboardPeers()`/the `rows.map(...)` block in `createDashboardViewModel()` (model.ts:106-120) builds `DashboardPeerRow` from `PeerRecord` field-by-field. If a plan only edits the renderer (`opentuiV3.ts`) to read `peer.contextPercent`, it will be reading from a `DashboardPeerRow`, not a raw `PeerRecord`, and the field won't exist until `model.ts` is also updated.
**How to avoid:** Any block-meter task must touch both `model.ts` (add fields to `DashboardPeerRow` type + populate in the `rows.map` block) and `opentuiV3.ts` (render them).

## Code Examples

### Existing group+peer row pattern to restyle (not rewrite the grouping mechanism)
```typescript
// Source: src/dashboard/opentuiV3.ts:469-492 — rosterLines()
// Keep this shape; change STATUS_ORDER to the 5-bucket triage order and change
// rosterLineChunks() peer-row formatting to match the sketch's column layout:
// ▶ + glyph, id (teal), engine chip, branch, activity, context meter, ⛁, elapsed (right-aligned, dim)
```

### Existing focus-glow precedent to generalize
```typescript
// Source: src/dashboard/opentuiV3.ts:882 (logsDrawer border color)
borderColor: state.drawerFocused ? theme.borderFocused : theme.border,
// Generalize: borderColor: state.focusPane === "dock" ? theme.borderFocused : theme.border  (rack pane too)
```

### Existing status-line message the render layer currently ignores
```typescript
// Source: src/dashboard/model.ts:289-303 — messageForState()
// Already produces exactly the text DASH-10 wants ("Kill selected peer? ...", "Reply to <id>: ...")
// but view.message is computed by createDashboardViewModel() using `state.mode` from
// dashboardState(state) in opentuiV3.ts:223-232, which HARD-CODES mode: "normal" — it never reads
// state.mode from RuntimeStateV3 at all. This is the actual wiring gap DASH-10 needs closed.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| V3 hand-rolled scroll offset (`visibleLogContent`, `withScrollbar`, `logProgressLine`) | `@opentui/core@0.2.4` ships a native `ScrollBoxRenderable` with `stickyScroll`/`stickyStart` | Present in the currently-pinned version (not a new upgrade) — V3 (built in Phase 1) simply didn't use it | Rework can delete ~60 lines of manual scroll math and gain more correct tail-follow behavior for free |
| Modal-based peer detail (`modalBox`, ~300 lines) | Sketch-locked fixed bottom dock | This phase | Large deletion; `modalTabBody`/`modalButtonRow`/`modalReveal` all become dead code once the dock replaces them |

**Deprecated/outdated:** `V3Mode` values `"modal" | "modal-answer" | "modal-kill" | "palette"` — palette (`:`/Ctrl+K command palette) is NOT mentioned anywhere in the sketch or DASH-09/10; recommend confirming with the user whether to keep it as a secondary feature (low risk, self-contained) or fold its actions (answer/kill/route-switch) into direct dock/rack interactions per the sketch's model. Not required to remove for these two requirements, but keeping it means one more `V3Mode` union member alongside the sketch's stated modes.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | GSD-specific statuses (`gsd_running_phase`, `gsd_polling_state`, etc.) should fold into the nearest of the sketch's 5 triage buckets rather than getting new buckets | Pattern 1 / Pitfall | If wrong, the rack either shows unexpected extra group headers (breaking the "5 buckets" visual contract) or misclassifies GSD peers into the wrong triage priority |
| A2 | The sketch's "green `#35e0d8`" context-level color is actually `cyberpunkTheme`'s teal accent, not a distinct green hex, and should reuse `theme.statusColors.starting`/`theme.borderFocused` rather than introduce a new color constant | Pattern 2 | Low risk — cosmetic; if wrong, a new hex needs adding to `theme.ts`, a one-line fix |
| A3 | `ScrollBox` is exported as a JSX-style factory function (like `Box`/`Text`) rather than requiring `new ScrollBoxRenderable(ctx, options)` construction | Pattern 3 | Medium risk — if the factory doesn't exist, the dock's log body needs the class-based construction path instead, which changes how it's added to the render tree (`renderer.root.add()` vs a factory call inline in JSX-style composition) |
| A4 | Route-switching (`1`-`5` digit keys → map/limits/uplink/alerts) stays out of scope and only the "fleet" route becomes the rack+dock layout | Anti-Patterns | Medium risk — if the user actually wants routes removed/folded into the dock, a plan built on this assumption under-scopes the phase |
| A5 | The existing `:`/Ctrl+K command palette (`V3Mode: "palette"`) is out of scope for this phase and can be kept as-is alongside the new rack/dock | State of the Art | Low risk — palette is self-contained; worst case it looks stylistically inconsistent until a follow-up phase |

## Open Questions

1. **Is `keybindings.ts`/`commandForKey()` the literal contract for DASH-10, or was "existing keybindings" meant loosely (i.e., "whatever V3 currently binds")?**
   - What we know: `keybindings.ts` is real, tested, and used by V2. V3 has its own separate, more elaborate key map (`v3Input.ts`) that the dashboard's actual users interact with today.
   - What's unclear: Whether the planner should (a) leave `keybindings.ts` untouched as V2-only and treat `v3Input.ts` as the source of truth for this phase, or (b) reconcile the two files so V3 also routes through `commandForKey()` (a much bigger refactor, not required by DASH-09/10's wording).
   - Recommendation: Treat (a) as correct — `v3Input.ts` is what real users press keys against. Flag this explicitly to the user in plan-check/discuss if a follow-up wants the files unified.

2. **Does `ScrollBox` export as a callable factory function in `@opentui/core@0.2.4`, matching `Box()`/`Text()` usage in `opentuiV3.ts`?**
   - What we know: The `.d.ts` confirms the class `ScrollBoxRenderable` and its full API (`stickyScroll`, `stickyStart`, `scrollTop`, `scrollHeight`, `scrollBy`, `scrollTo`) exist and are exported from `renderables/index.d.ts` → top-level `index.d.ts`.
   - What's unclear: Whether calling code uses `ScrollBox({...options}, ...children)` (factory sugar, like `Box`) or must `new ScrellBoxRenderable(ctx, options)` it directly, which changes the render-tree composition style used throughout `opentuiV3.ts`.
   - Recommendation: First task in the plan's Wave 0 should be a 5-minute spike — grep the compiled `@opentui/core` JS for a `ScrollBox` factory export (parallel to how `Box`/`Text` are defined) before committing task-by-task tickets to the ScrollBox-based dock design. If no factory exists, fall back to keeping the current hand-rolled scroll math (Pattern 3's "don't hand-roll" recommendation becomes optional, not blocking).

3. **Should the four secondary routes (map/limits/uplink/alerts) survive this phase unchanged, be visually restyled to match cyberpunkTheme's sharper rack aesthetic, or be removed?**
   - What we know: None of DASH-09/10 or the sketch mention them. Success Criterion 5 ("palette exactly matches cyberpunkTheme ... no rounded/soft web-app styling") arguably already applies to them today since `cyberpunkTheme` is global, not per-route.
   - What's unclear: Whether "no rounded/soft web-app styling" is meant to gate a full-app visual QA pass across all 5 routes, or narrowly the new rack+dock.
   - Recommendation: Scope this phase to the fleet route (rack+dock) only; treat the other 4 routes as untouched/out of scope unless the user says otherwise during plan-check.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Dashboard entry (`bunEntryV2.js`) | ✓ | 1.3.13 | — |
| `@opentui/core` | All dashboard rendering | ✓ | 0.2.4 (pinned) | — |
| Node.js | MCP/CLI/tests (`npm run test`, `tsc`) | ✓ (assumed on dev machine per `engines.node >=20` in package.json) [ASSUMED — not directly probed this session] | — | — |

**Missing dependencies with no fallback:** None identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node --test` against compiled `dist/*.js` (see `tests/*.test.mjs`), plus `vitest` for `src/frozen-gate`/`src/frozen-eligibility` (unrelated to dashboard) |
| Config file | none dedicated — `package.json` script `"test": "npm run build && node --test tests/*.test.mjs"` |
| Quick run command | `npx tsc -p tsconfig.json --noEmit` (fast type-check without full build) |
| Full suite command | `npm run test` (builds then runs all `tests/*.test.mjs`, including `tests/dashboard.test.mjs`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DASH-09 | Status grouping/triage order, view-model exposes `contextPercent`/`contextLevel`/`compacted` per row, counts by status | unit (pure `model.ts` functions, testable without a terminal) | `node --test tests/dashboard.test.mjs` (add new assertions to existing `createDashboardViewModel` test block) | ✅ file exists, needs new assertions — ❌ new context-meter assertions Wave 0 |
| DASH-09 | Block-meter glyph/color rendering logic (e.g., a pure `contextMeterChunks()` helper) | unit | `node --test tests/dashboard.test.mjs` (new test if the helper is exported) | ❌ Wave 0 — extract as a small pure exported function so it's unit-testable without a live renderer |
| DASH-10 | Kill-confirm / answer mode transitions (status-line, not modal) | unit (`v3Input.ts` command routing, mirroring existing `v3CommandForKey`/`handleDashboardV3Input` tests) | `node --test tests/dashboard.test.mjs` | ✅ pattern exists (existing modal-mode tests at lines ~371-402), needs updating once modes are renamed |
| DASH-10 | Tab focus cycling between rack and dock | unit | `node --test tests/dashboard.test.mjs` | ❌ Wave 0 — no test currently exercises `toggleDrawerFocus`-equivalent generalized to two panes |
| DASH-10 | Tail-follow / scroll position indicator math | unit if kept hand-rolled, or **manual smoke** if delegated fully to `ScrollBoxRenderable` (no direct unit-test surface for a live renderer's scroll state without a headless terminal) | `node --test tests/dashboard.test.mjs` (if a pure helper remains) OR `CODEX_PEERS_DASHBOARD_SMOKE=1 bun src/dashboard/bunEntryV2.js` (manual/smoke path, matches existing smoke-mode env var already wired in `opentuiV3.ts:211`) | Partial — smoke path exists; no automated assertion on rendered scroll state |
| Success Criterion 6 (MCP/CLI/supervision unaffected) | Full existing suite green | full suite | `npm run test` | ✅ |

### Sampling Rate
- **Per task commit:** `npx tsc -p tsconfig.json --noEmit` (fast) + relevant `node --test tests/dashboard.test.mjs` subset
- **Per wave merge:** `npm run test` (full suite, includes build)
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus a manual `CODEX_PEERS_DASHBOARD_SMOKE=1` run (or interactive `bun` run) since OpenTUI rendering itself has no headless assertion path in this repo today.

### Wave 0 Gaps
- [ ] Extend `tests/dashboard.test.mjs`'s `createDashboardViewModel` tests with `contextPercent`/`contextLevel`/`compacted` fixtures once `DashboardPeerRow` carries them.
- [ ] Add unit tests for the new triage-order grouping helper (5-bucket, not the current 15-status `STATUS_ORDER`).
- [ ] Add unit tests for the renamed kill-confirm/answer mode transitions in `v3Input.ts` once modal-based flow is retired.
- [ ] Spike/confirm `ScrollBox` factory export before committing the dock's log body to that primitive (see Open Question 2) — if it doesn't exist as a factory, keep hand-rolled scroll logic and test it the way `visibleLogContent`/`scrollPosition` presumably would be (currently untested — no existing unit test for these functions either, worth adding regardless).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Local single-user TUI, no auth surface |
| V3 Session Management | No | No web/HTTP session concept in this phase |
| V4 Access Control | No | Local process supervision only; no multi-tenant boundary |
| V5 Input Validation | Yes (narrow) | The dock's answer-mode text input (`state.answerInput`) is passed to `resumePeer({ peerId, prompt: text })` — already trimmed/empty-checked in `submitAnswer()` (`v3Input.ts:639-656`). No change needed; keep the existing `.trim()` + empty-string rejection when moving this logic out of the modal. |
| V6 Cryptography | No | Not applicable — no secrets/crypto touched by this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Arbitrary text passed to `killPeer`/`resumePeer` (peer id spoofing via stale state) | Tampering | Already mitigated: `selectedPeer(state)` looks up by id against `state.visiblePeers` (server-refreshed each tick), and `killPeer`/`resumePeer` (in `peerManager.ts`, out of scope this phase) presumably validate the id server-side — no new surface introduced by moving the UI from modal to dock |
| Terminal escape-sequence injection via log lines rendered verbatim (e.g., a malicious peer log line containing ANSI control codes) | Tampering/Information Disclosure | Pre-existing risk, not introduced by this phase — `LogBuffer`/`parseLogChunk` already treat log content as untrusted text and OpenTUI's `Text`/`StyledText` renderer is responsible for safe escaping; no new handling needed since the dock reuses the same `view.logLines`/`formatDashboardLogEvents` pipeline unchanged |

No new security surface is introduced by this phase — it is a pure presentation-layer rework of already-validated data paths (`listPeers()`, `LogBuffer`, `killPeer`, `resumePeer` are all untouched).

## Sources

### Primary (HIGH confidence — direct file reads this session)
- `src/dashboard/opentuiV3.ts` — full 1418-line read
- `src/dashboard/v3Input.ts` — full 804-line read
- `src/dashboard/model.ts` — full 645-line read
- `src/dashboard/theme.ts` — full read
- `src/dashboard/keybindings.ts` — full read
- `src/dashboard/v2Input.ts` — partial read (confirms `commandForKey` usage)
- `src/dashboard/logEvents.ts` — full read
- `src/dashboard.ts`, `src/dashboard/opentuiRuntime.ts` — full read
- `src/dashboard/bunEntryV2.ts` — full read (confirms V2/V3 entry selection)
- `src/codexContext.ts` — full read (contextPercent/contextLevel/compacted source)
- `src/types.ts` (lines 70-110) — `PeerRecord` field confirmation
- `tests/dashboard.test.mjs` — grep/partial read (confirms current test coverage and that `keybindings.ts` is V2-only in practice)
- `node_modules/@opentui/core/renderables/ScrollBox.d.ts`, `Box.d.ts`, `index.d.ts`, `renderables/index.d.ts` — confirms `ScrollBoxRenderable` API surface exists in the installed version
- `.claude/skills/sketch-findings-delamain/SKILL.md`, `references/layout-and-density.md`, `references/keyboard-and-detail-dock.md` — the locked design contract
- `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json` — phase scope, requirements wording, workflow flags
- `bun --version` (1.3.13) — direct tool probe

### Secondary (MEDIUM confidence)
- None required — no web research was needed; this phase is entirely groundable in the existing repo.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; existing pinned versions confirmed directly
- Architecture: HIGH — every pattern cited traces to a specific file/line read this session
- Pitfalls: HIGH — all four pitfalls are concrete code-level findings (keybindings.ts dead-code-for-V3, modal-vs-status-line divergence, unplumbed context fields, DashboardPeerRow gap), not speculative
- ScrollBox factory-export question (Open Question 2): MEDIUM — API surface confirmed via `.d.ts`, but factory-vs-class usage pattern not confirmed by reading actual `.js` implementation or a working example

**Research date:** 2026-07-07
**Valid until:** 30 days (stable, dependency-free codebase research; revalidate if `@opentui/core` is upgraded before planning executes)
