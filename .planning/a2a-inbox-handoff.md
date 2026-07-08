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
| T1 | `src/peerInbox.ts` (new), `src/types.ts` (additive), `src/peerInbox.test.ts` (new) | Envelope types, enqueue/read/drain/markDelivered store fns, notice derivation, delivery-prompt formatter | PARTIAL — never landed as its own slice; T3 authored a provisional subset (envelope types, `enqueuePeerMessage`, `readPeerInbox`, `noticeForStatus`, additive `inbox?` field), marked `ponytail: PROVISIONAL T1`. Missing: `drain`/`markDelivered`, delivery-prompt formatter (those are T2's deps). |
| T2 | `src/runner.ts`, `src/peerManager.ts`, `src/lifecycle.ts` (whichever owns the status flip), tests | Drain-on-boundary delivery via `resumePeer`, no regression to `send_peer_reply` | NOT LANDED — no `deliver_pending`/`drain`/runner-exit hook exists anywhere in the branch. Turn-boundary auto-delivery is absent; messages are readable only via `read_peer_inbox`/`delamain inbox`. See Open risks. |
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

## Verification results (T4, 2026-07-08)

- `npm run build` → exit 0 (`tsc -p tsconfig.json && chmod +x dist/index.js`).
- `npx vitest run` (raw, unfiltered) → `Test Files 10 passed | 1 skipped (11)`; `Tests 57 passed | 2 skipped (59)`; duration ~898ms. 0 failures.
- `send_peer_reply` dispatch case UNCHANGED vs `origin/main`: `git diff origin/main -- src/mcpServer.ts` touches only (a) the `instructions` string — additive sentence documenting the two new tools — and (b) the new `send_peer_message`/`read_peer_inbox` cases. The `case "send_peer_reply": return json(resumePeer(...))` block is byte-identical.
- Seam: `send_peer_message` is ENQUEUE-ONLY (mcpServer.ts:502-515, `ponytail:` comment in place). The intended one-line wire to T2's `deliver_pending` was NOT applied because T2 never landed — no such helper exists to import. Flagged, not fabricated.
- CLI docs verified against source: `send` (`--to`/`--message`/`--from`/`--expect-reply`/`--response-id`, stdin fallback for message), `inbox [<peer-id>] [--all]` (→ `includeDelivered`), `--from` inferred via `inferSelfPeerId()` realpath cwd↔`worktreePath` match.

## Open risks

- **T2 entirely missing (HIGH).** Turn-boundary auto-delivery via `resumePeer` does not exist. Today a sent message only surfaces when the recipient actively calls `read_peer_inbox`/`delamain inbox`; nothing drains the inbox or injects it into a peer's next turn. The feature is half-wired: send + read work, push-on-boundary does not. Land T2 (runner-exit drain hook in `runner.ts` `child.on("close")` after the final `updatePeer`, per T2's own trace) then apply the one-line seam wire in `send_peer_message`.
- **`peerInbox.ts` is provisional (MEDIUM).** Authored under T3 as `ponytail: PROVISIONAL T1`. If a real T1 module ever lands, reconcile to the superset and re-point imports; current provisional API already matches the handoff contract, so name-compatible T1 needs no T3/T4 changes.
- Concurrent state.json writers (pre-existing, now slightly wider surface) — per-peer lock is the upgrade path; `enqueuePeerMessage` uses read-modify-write via `updatePeer`, so two concurrent MCP processes can still clobber.
- Peer→CLI send requires `delamain` binary on PATH inside worktrees — unverified for npx-only setups.
- Delivery prompt format not authored (T2 dep) and not consumed by any real peer run — no live fleet round-trip yet.
