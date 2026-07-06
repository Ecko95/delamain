# Dashboard v2 improvements — design

**Status:** approved, ready for planning
**Research:** [`docs/superpowers/specs/2026-07-06-dashboard-v2-improvements-research.md`](2026-07-06-dashboard-v2-improvements-research.md)
**Scope:** logs pipeline, fleet grid, answer-from-dashboard, unify input handling + help overlay, richer peer rows. Diff viewer, activity timeline, mouse support explicitly deferred.

## 1. Structured, instant-history logs

### Data model

New `src/dashboard/logEvents.ts`:

```ts
export type LogEventKind = "message" | "reasoning" | "command" | "file_change" | "error" | "turn" | "delamain" | "raw";
export type LogEvent = {
  at: string;        // HH:MM:SS, stamped at ingest (source streams carry no per-line timestamp)
  kind: LogEventKind;
  level: "info" | "warn" | "error";
  title: string;
  body?: string[];
};

export function parseLogChunk(raw: string): LogEvent[];
```

`parseLogChunk` replaces `formatDashboardLogLine`'s per-key branching (`model.ts:284`) with explicit handling of the real Codex/Cursor event vocabulary (`thread.started`, `turn.*`, `item.*` with types `agent_message`/`reasoning`/`command_execution`/`file_change`/`mcp_tool_call`/`web_search`/`error`). Unknown shapes fall back to a single compact `kind: "raw"` line — never a raw JSON dump. `file_change` becomes `edit  src/foo.ts (+12 -3)`; errors and non-zero exit codes become `level: "error"`, which the renderer maps to the active theme's error color and rolls into an `N errors` badge in the log pane title.

### Incremental tail (the actual "instant history" fix)

New `LogBuffer` per peer (owned alongside the existing `cachedLogText` state in `opentuiV2.ts`):

- Tracks a byte offset per peer's log file. Each refresh tick: `fs.statSync` to check size, and if grown, read only the new bytes at that offset (`fs.openSync` + `read`), parse into `LogEvent[]`, append to a ring buffer capped at ~2,000 events.
- On peer switch, seed the buffer with one bounded read (last 256KB of the file) rather than the full file.
- This replaces the current behavior of re-reading the whole file every `LOG_REFRESH_MS` tick and hard-capping at 80 lines (`opentuiV2.ts:56`, `model.ts`'s `LOG_LIMIT = 80`). Scrollback pages over the in-memory ring buffer — no file I/O on scroll, and history extends to the full 2,000-event buffer instead of 80 lines.

### Rendering

Log pane renders `LogEvent[]` instead of formatted strings directly: a dim `HH:MM:SS` gutter, theme-colored `kind`/`level`, collapsible `reasoning` lines. `formatDashboardLogLines` stays as a thin string-producing adapter over the same events so existing test expectations in `tests/dashboard.test.mjs` keep working where they assert on rendered strings.

### Keybinding

`e` = jump to the previous `error`-level event in the buffer (cheap once events are typed; full `/`-search deferred).

## 2. Fleet grid (functional signal map)

Replaces the current status-counts-only overview pane (`overviewPane`, `opentuiV2.ts:456`) with a 2D grid: **columns = project**, **rows = lifecycle stage** (spawn → working → waiting → integrate → done/failed, via `dashboardStatus`'s existing status mapping). Each peer renders as a glyph in its cell — spinner frame if active, `●` with a question-mark accent if waiting, `✔`/`✖` if done/failed — colored via the active theme's `statusColor`.

- **Data:** zero new collection — every field (`status`, `project`) already exists on `DashboardPeerRow`.
- **Interaction:** when the overview pane is focused, `h/j/k/l` moves a cursor between occupied cells and updates `selectedPeerId`, syncing with the peers list and details pane — the grid is a navigation surface, not decoration.
- **Rendering:** plain `TextChunk` rows exactly like the existing `peerContent` rendering path — no new rendering primitives.

## 3. Answer waiting peers from the dashboard

A `waiting` peer already surfaces its question in the details pane (`detailRows` pushes `question`), but the only actions today are kill/quit. New mode `answer`, entered with `a` when a `waiting` peer is selected: a single-line footer input, submitted with Enter, calling the existing reply path already used by `send_peer_reply` in `peerManager.ts`. Cancel with Escape, same pattern as the existing `kill-confirm` mode.

## 4. Unify input handling; add help overlay

`opentuiV2.ts` currently reimplements key handling inline (`opentuiV2.ts:204`) instead of routing through `keybindings.ts`'s `commandForKey`, which V1's tests exercise but V2 doesn't use — a drifting parallel implementation. Fix: route V2's input handler through `commandForKey`, extending its `DashboardCommand` union with the new commands this design adds (`cycle-theme` from the theme design, `answer`, `jump-error`, `help`). Wire the existing but-unreachable `DashboardMode: "help"` (`model.ts:6`) to a `?` binding, rendering a full keybinding reference instead of the current cramped, truncated single-line footer (`footerPane`, `opentuiV2.ts:575`).

## 5. Richer peer rows

`peerDisplayLine` (`opentuiV2.ts:658`) shows id/elapsed/status/project but drops `lastEvent` and `question`, both already present on `DashboardPeerRow`. On rows wide enough, append a dim truncated `lastEvent`; for `waiting` peers, show the start of `question` instead. Turns the peer list into a triage view without leaving it.

## Non-goals (explicitly deferred)

- Activity timeline view (research §2B) — needs new sampled history state; ship after the grid proves out.
- Diff viewer (research finding 4) — separate, larger piece of work.
- Mouse support (research finding 6) — nice-to-have after the above land.
- Full retained-mode render rewrite — the render-skip-when-unchanged optimization (research finding 3) is small enough to fold into this pass's log/grid work if it falls out naturally, but isn't a hard requirement of this design.

## Testing

- `parseLogChunk` unit tests: one per event kind (message/reasoning/command/file_change/error/unknown-raw), asserting no case falls through to a raw JSON string.
- `LogBuffer` test: simulate file growth across two reads, assert only the appended bytes are parsed (no duplicate events) and the ring buffer caps at its configured size.
- Fleet grid: a pure function `fleetGridCells(peers): Cell[]` (project × stage bucketing), tested directly without rendering.
- `commandForKey` tests extended for `answer`, `jump-error`, `help` alongside the existing V1 command tests — and a regression test asserting V2's input handler produces the same command for a given key as `commandForKey` (closes the drift risk called out in §4).
- Answer-mode: test that submitting text in `answer` mode calls the same reply function `send_peer_reply` already uses, with the selected peer's id and the typed text.
