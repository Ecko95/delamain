# A2A Peer Inbox — Orchestration Handoff

Frontier orchestrator: Fable. Executors: Opus, medium effort. Worktree: `.claude/worktrees/a2a-peer-inbox` (branch `worktree-a2a-peer-inbox`).

## Scope

Implement R2+R4 from the Traycer re-evaluation: peer↔peer messaging for delamain via a per-peer mailbox with turn-boundary delivery. Envelope schema ported from Traycer's open protocol (`sendAgentMessageRequestSchema` / `agentInboxMessageSchema` / reply discriminated union / inactivity-notice reasons), body stays freeform prose.

**Non-goals (v1):** GITS surfacing/policy gating (gitscode repo), cross-provider context replay (R5), Motoko wiring, streaming subscribe, dashboard UI, mid-task injection, cross-machine relay, gsd-comms verb taxonomy on the wire, durable DB.

## Decisions (why, one line each)

1. Inbox = optional `inbox?: PeerMessage[]` on `PeerRecord` in state.json — follows the `kind` additive-migration precedent (`normalizePeerRecord`); no new storage. Ceiling: whole-file write races between concurrent MCP processes are pre-existing; mark with `ponytail:` comment.
2. Notices derived on read from receiver `PeerStatus` (failed→errored, killed→receiver-cancelled, waiting→awaiting-input, done/idle→turn-ended, frozen→quiet) — no sweep daemon exists in delamain, so compute instead of push.
3. Delivery = turn-boundary only, via existing `resumePeer()`: immediate when receiver is at a boundary (waiting/idle/done), queued while working, drained where status transitions at runner exit. Traycer's source proves mid-task injection is unsolved for codex/cursor headless — don't attempt it.
4. Message body is untyped prose + typed envelope (Traycer's bet). `expectReply=true` mints a `responseId`; receiver closes the thread by echoing it with `expectReply=false`.
5. Send surfaces: MCP tool `send_peer_message` (orchestrator/Motoko path) + CLI `delamain send` / `delamain inbox` (peer path; `--from` inferred by matching cwd to a peer's `worktreePath`). No peer-side MCP registration in v1.

## Task table

| ID | Owner files | Outcome | Status |
|----|-------------|---------|--------|
| T1 | `src/peerInbox.ts` (canonical), `src/types.ts` (additive) | Envelope types, enqueue/read/drain store fns, notice derivation, delivery-prompt formatter | DONE-as-canonical — the provisional T3 module is now the canonical T1: `PROVISIONAL` header rewritten to `CANONICAL`; added `drainDeliverable` (returns undelivered + stamps `deliveredAt`) and `formatInboxPrompt` (per-message sender header, optional responseId line, body, reply instructions when `expectReply`). No separate `src/types.ts` change needed — `inbox?`/`deliveredAt` already landed under T3. |
| T2 | `src/runner.ts`, `src/peerManager.ts`, `src/peerDelivery.test.ts` (new) | Drain-on-boundary delivery via `resumePeer`, no regression to `send_peer_reply` | DONE — this commit. `deliverPending(peerId, resume=resumePeer)` in peerManager (re-reads status, delivers only at waiting/idle/done with a threadId + undelivered mail, resumes once); runner-exit hook after the final `updatePeer` in `child.on("close")` (best-effort, wrapped, logs to peer log); mcpServer `send_peer_message` seam wires `deliverPending(to_peer_id)` and returns its outcome. `send_peer_reply` dispatch block byte-identical. |
| T3 | `src/mcpServer.ts`, `src/cli.ts`, tests | MCP tools `send_peer_message` + `read_peer_inbox`; CLI `send`/`inbox` subcommands with cwd self-id inference | DONE — commit `4e4e1f5`. |
| T4 | `README.md`, run verification | Docs section + full build/test verification report | DONE — this commit. Seam fix not possible (T2 dep absent); README + handoff updated; full verification below. |

Order: T1 → (T2 ∥ T3) → T4 → Fable review gate.

## Acceptance criteria (machine-checkable)

- `npm run build` exits 0; `npx vitest run` fully green (existing + new).
- Tests prove: enqueue→read roundtrip; boundary delivery calls resume exactly once with a prompt containing sender id + reply instructions; responseId mint/echo lifecycle; notice-per-status map; state.json without `inbox` still loads (backward compat).
- `send_peer_reply` behavior unchanged (existing tests pass untouched).
- MCP dispatch handles the two new tool names; unknown-tool path unchanged.

## Blast radius

- state.json consumers: dashboard v2/v3 read `PeerRecord` — additive optional field must survive `normalizePeerRecord` (verify it doesn't strip unknown keys).
- `resumePeer` reuse: collision between auto-delivery and operator `send_peer_reply` → guard: re-read status inside drain, skip if not at boundary.
- Runner exit path: hook must be no-op when inbox empty.
- CLI on peer PATH: `package.json` bin exposes `delamain` — T3 verifies.

## Ponytail review (pre-implementation gate)

- **Keep:** envelope fields, per-peer queue in existing store, resumePeer delivery, CLI+MCP dual surface.
- **Change:** notices computed on read (was: active sweep) — delamain has no daemon; the dashboard can poll later.
- **Drop:** subscribe stream, ack/read-receipts (liveness substitutes), separate broker process, message retention pruning (state.json is small; revisit if it bloats).

## Verification results (T2, 2026-07-08)

- `npm run build` → exit 0 (`tsc -p tsconfig.json && chmod +x dist/index.js`).
- `npx vitest run` (raw, unfiltered) → `Test Files 11 passed | 1 skipped (12)`; `Tests 63 passed | 2 skipped (65)`; duration ~1.03s. 0 failures. (Before T2: 10 files / 57 tests. New file `src/peerDelivery.test.ts` adds 6 tests.)
- `send_peer_reply` dispatch case UNCHANGED vs `origin/main`: `git diff origin/main -- src/mcpServer.ts` touches only (a) the `instructions` string — now also documenting `send_peer_message`/`read_peer_inbox` — and (b) the `send_peer_message`/`read_peer_inbox` cases + the `deliverPending` import. The `case "send_peer_reply": return json(resumePeer(...))` block is byte-identical.
- Seam: `send_peer_message` now enqueues then calls `deliverPending(to_peer_id)` and returns `{ response_id, delivery }`. Enqueue-only `ponytail:` comment removed.

## Open risks

- Concurrent state.json writers (pre-existing, now slightly wider surface) — per-peer lock is the upgrade path; `enqueuePeerMessage`/`drainDeliverable` use read-modify-write via `updatePeer`, so two concurrent MCP processes can still clobber. A boundary send racing the runner-exit drain can double-drain (both see undelivered) → at-most a duplicate resume, not lost mail.
- Peer→CLI send requires `delamain` binary on PATH inside worktrees — unverified for npx-only setups.
- Delivery not yet exercised in a live fleet round-trip; `deliverPending` proven via injected `resume` in tests, not against a real `resumePeer`/codex spawn. Message loss window: if `resumePeer` throws *after* `drainDeliverable` stamps `deliveredAt`, those messages are marked delivered but never injected (the `!peer.threadId` guard covers the common no-thread case; a real spawn failure would still drop them).
