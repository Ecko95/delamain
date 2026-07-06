# Dashboard v2 improvements — research (2026-07-06)

Research only, no code. Feeds the next design spec. Separate from the cyberpunk theme work (cosmetics unchanged here).

## 1. Instant/formatted logs history

### Today

- `readPeerLog` (`src/peerManager.ts:256`) re-reads the **entire** log file with `readFileSync` and slices the last N lines. The dashboard calls it every 1.5s (`LOG_REFRESH_MS`, `src/dashboard/opentuiV2.ts:56`) with a hard `logLimit: 80` raw lines. Scrolling up (`logOffset`) only pages within that same 80-raw-line tail — **there is no real history**; older events are unreachable from the dashboard even though the file has them. `safeLogTail` (`src/dashboard/model.ts:269`) also caps at `LOG_LIMIT = 80`.
- Formatting already exists but is shallow: `formatDashboardLogLine` (`src/dashboard/model.ts:284`) parses each JSON line, emits an icon + `type/item.type` header, `text:` / `command:` / `result:` / `output:` sub-lines, then dumps every unrecognized field as `json: {...}` (the `compactJsonWithout` fallback). Practical effect: real Codex/Cursor streams still render as truncated one-line JSON blobs for anything outside the handful of known keys, with no timestamps, no color, and re-parse of all 80 lines on every 120ms render tick (formatting runs inside `createDashboardViewModel`, not cached).

### Proposal

**a. Structured event model, not string lines.** Change the pipeline from `string[] → string[]` to `string → LogEvent[]` where `LogEvent = { at?: string; kind: "message" | "reasoning" | "command" | "file_change" | "error" | "turn" | "delamain" | "raw"; title: string; body?: string[]; level: "info" | "warn" | "error" }`. The renderer maps `kind`/`level` to the active theme's colors (errors red, file edits green, commands cyan, reasoning dim) instead of today's emoji-only differentiation. Keep `formatDashboardLogLines` as a thin adapter so `tests/dashboard.test.mjs:123` conventions carry over.

**b. Parse the actual event vocabulary.** Codex `exec --json` emits `thread.started`, `turn.started/completed/failed`, `item.started/completed` with item types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error`; Cursor emits its own stream-JSON shape. Handle each explicitly:
- `file_change` → `edit  src/foo.ts (+12 -3)` style line per file (today it falls into the `json:` dump).
- `error` / `turn.failed` / non-zero `exit_code` → level "error", rendered in the error color and counted in a small `N errors` badge in the pane title.
- `reasoning` → single dim line, collapsible.
- Timestamps: Codex events carry none per line, so stamp events with wall-clock at ingest (see c) and render a dim `HH:MM:SS` gutter; `[delamain]` lines already have context.
- Unknown events → one compact dim line, never a raw JSON dump.

**c. Instant history via incremental tail.** Replace poll-and-reslice with a per-peer `LogBuffer`: `fs.statSync` size check each tick, read only the appended bytes from the last offset (`fs.openSync` + `read` at offset), parse new lines into events, append to a ring buffer of ~2,000 events. Scrollback then pages over the buffer in memory — instant, no file I/O on scroll, and history goes far beyond 80 lines. On peer switch, do one full read (bounded, e.g. last 256KB) to seed the buffer. This also kills the current whole-file re-read every 1.5s, which gets slow as logs grow.
- `ponytail` note: ring buffer + byte-offset tail is ~60 lines; no need for an index file or sqlite.

**d. Keybindings.** `/`-style search is tempting but defer it; ship `e` = jump to previous error event first (cheap, high value once events are typed).

**Complexity: medium** (parser small; the tail/buffer plumbing replaces the `cachedLogText` logic in `opentuiV2.ts:104-118`).

## 2. Functional "signal map" replacement

The mockup radar (`docs/superpowers/mockups/...mockups.html`, `.radar`/`.blip`) is decorative. Three candidate functional versions, ranked; recommend **A**, with **B** as a stretch.

### A. Fleet grid — status-position map (recommended)

A compact 2D character grid where **columns = project/repo** and **rows = lifecycle stage** (spawn → working → waiting → integrate → done/failed). Each peer is a blip glyph in its cell, colored by `statusColor`, pulsing (spinner glyph) when active:

```
            delamain   isomer    acme/app
 spawn                            ◌ p-12
 work        ⠹ p-04    ⠹ p-07
 wait                             ● p-09?
 integ       ▲ p-02
 done/fail   ✔ p-01    ✖ p-05
```

- Data: all fields already exist on `DashboardPeerRow` (`status`, `project`) — zero new data collection. `dashboardStatus` maps ~16 statuses into the 5 stage rows (GSD states fold into work/wait/done/fail).
- Interaction: it replaces/augments the Overview pane (`overviewPane`, `opentuiV2.ts:456`, currently just status counts). When focused, j/k/h/l moves a cursor between blips and syncs `selectedPeerId` — so the map is a navigation surface, not wallpaper. Waiting peers get the attention glyph (`●?`) since `waiting` is rank 0 in `statusRank`.
- Render: plain `TextChunk` rows, same as `peerContent`; fits the existing 8-row pane height for ~3 projects, grows with pane.
- **Complexity: medium.**

### B. Activity timeline (stretch / alternative)

Horizontal per-peer lanes, last N minutes, one column per time bucket, colored by the status the peer had in that bucket:

```
 p-04  ▁▁▂▄██████▶        working 12m
 p-09  ▁▄██▌?????         waiting 4m on question
 p-05  ▄██✖                failed at 12:41
```

- Needs one new piece of data: a small in-dashboard history of `(peerId, status, timestamp)` sampled from the existing 1s `listPeers()` poll — a ring buffer in `RuntimeState`, nothing persisted. Answers "when did it stall / how long has it been waiting" at a glance, which the current `elapsed` column only partially covers.
- **Complexity: medium** (sampling is trivial; bucket→glyph rendering is the work).

### C. Worktree/branch graph — not recommended now

An ASCII tree of `origin/main → base ref → peer branches → merge target` per repo. The data exists (`baseRef`, `mergeBranch`, `worktreeBranch`, `gitCommonDir`) but the warnings pane + details pane already cover the collision/relationship story (`analyzeWorktrees`, `model.ts:495`); a full graph is mostly redundant. Skip unless fleet sizes grow. **Complexity: large** for its value.

## 3. Other recommended improvements (ranked)

1. **Answer waiting peers from the dashboard.** Today a `waiting` peer shows its question (`detailRows` pushes `question`) but the only actions are kill/quit — you must leave the TUI and call `send_peer_reply`. Add `a` = answer mode: a one-line input in the footer that calls the existing reply path in `peerManager`. This closes the single most common supervision loop. **Medium.**
2. **Help overlay is dead code in V2.** `DashboardMode` includes `"help"` (`model.ts:6`) and the footer crams all keys into one truncated line (`footerPane`, `opentuiV2.ts:575`), but `handleInput` in opentuiV2 never enters help mode and `keybindings.ts` (which has no `?` binding either) isn't even used by V2 — V2 re-implements input handling inline (`opentuiV2.ts:204`), so `keybindings.ts` + its tests cover a parallel, drifting copy. Fix both: route V2 input through `commandForKey` and add a `?` help overlay. **Small.**
3. **Full-file re-read + full re-render every 120ms.** Every tick destroys and rebuilds the whole component tree (`render`, `opentuiV2.ts:331` `destroyRecursively` loop) and `listPeers()` re-reads state every 1s regardless of change. Fine at 5 peers, wasteful at 30. Cheap wins: skip render when the view-model hash is unchanged; the log tail fix in §1c removes the other hot path. Full retained-mode rewrite not needed. **Small–medium.**
4. **Diff detail is a one-liner; no way to see the actual diff.** `diffStatProvider` renders only `N files +a -b` (`opentuiV2.ts:126`). Add `d` = diff view: swap the logs pane content for `git diff --stat` per-file list (reusing `worktreeDiffStat`/`git.ts`), enter on a file for its patch, colored +/- like `detailValue` already does. **Medium.**
5. **Peer rows hide the most useful live signal.** `peerDisplayLine` (`opentuiV2.ts:658`) shows id/elapsed/status/project but drops `lastEvent`/`question`, which the row model already carries (`DashboardPeerRow.lastEvent`). On wide layouts append a dim truncated `lastEvent`; for `waiting` peers show the question start. Turns the list into a real triage view. **Small.**
6. **Mouse support.** OpenTUI supports mouse events; click-to-select peer and wheel-scroll logs would remove most focus-cycling friction (tab through 7 panes today). Nice-to-have after 1–5. **Medium.**

## Suggested v2 scope

Logs pipeline (§1) + fleet grid (§2A) + items 1, 2, 5 above. Defer timeline (§2B), diff viewer, and mouse to a v2.1.
