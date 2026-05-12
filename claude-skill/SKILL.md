---
name: codex-peers-autopilot
description: Drive a chain of codex-peers handoffs autonomously through a multi-slice roadmap. Spawns peers from a TSV roadmap, auto-reviews each result (lint/typecheck/tests/build + forbidden-touch diff), auto-creates and rebase-merges PRs via gh, detects merge via git cherry patch-id, advances to the next slice, and notifies a Telegram chat at every state transition. Use when the user wants to execute a long sequence of peer handoffs end-to-end with halt-on-failure safety, when they say "set up an autopilot for this roadmap", "drive these peer handoffs autonomously", "telegram-notify on every peer event", or wants the system that supervises a vertical-slice plan from spawn to merged-to-main without manual intervention.
---

<essential_principles>
**Autopilot is opinionated, not configurable.** This skill installs a single working pattern: cron-driven Python supervisor + bash Telegram helper + per-roadmap state directory. Don't let users tune knobs that aren't in the config.json schema; if they need a different pattern they should fork the script. The whole point is that this is reproducible.

**Halt-on-failure is non-negotiable.** Every error path sets `state.halted = true` with a `halted_reason`, sends a Telegram, and exits 0. The chain only advances when every gate is green. Resume is always manual: edit `state.json` after the human verifies recovery is safe.

**Single-instance lock at the top of every tick.** The supervisor uses `flock` on `<state-dir>/.supervisor.lock`. Cron firing while a long auto-review is still running must skip cleanly, never overlap. Never remove this guard.

**Idempotent notifications via `notified_events`.** Every Telegram message is keyed by an event ID (`spawn:<peer>`, `auto-merged:<peer>`, `merged:<peer>`, `waiting:<peer>:<lastEvent>`, `failed:<peer>`). Mark the event before sending, but only after `save_state` succeeds, so a crash mid-tick doesn't double-notify.

**Hard redaction in peer prompts.** The peer-prompt template forbids rendering raw tokens, URLs, provider payloads, SFTP paths, or PII beyond API-projected fields. Don't strip this from the template.

**Never auto-merge to the project's default branch without an auto-review pass.** If the user wants "spawn but don't auto-merge", route them to a different mode (Telegram-tap-to-merge or notify-only) — but the canonical autopilot includes auto-review and auto-merge together. They are the same gate.

**Branch hygiene.** Every slice gets its own `<merge_branch>` pre-created on origin from origin/<default>. Auto-merge uses `--rebase --delete-branch`. Merge detection uses `git cherry` patch-id, which catches rebase + squash merges where SHAs are rewritten. Direct ancestry is the fast path.
</essential_principles>

<intake>
What do you want to do?

1. **Bootstrap a new roadmap** — scaffold state dir, install creds, generate handoffs.tsv, schedule cron, optionally spawn slice 0
2. **Attach to an already-running peer** — register an in-flight codex-peer as slice 0 of a new chain (e.g. you spawned manually, now want the autopilot to take over)
3. **Resume a halted chain** — diagnose `state.halted = true`, inspect the reason, propose recovery, optionally clear halt
4. **Audit current chain state** — print active roadmap, current peer status, recent log lines, pending PRs, history outcomes

Wait for the user to choose before proceeding.
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "bootstrap", "new roadmap", "set up", "install" | workflows/bootstrap-new-roadmap.md |
| 2, "attach", "running peer", "in flight", "take over" | workflows/attach-to-running-peer.md |
| 3, "resume", "halted", "unhalt", "recover" | workflows/resume-halted-chain.md |
| 4, "audit", "status", "what's running", "check chain" | workflows/audit-chain-state.md |

**Intent-based routing without explicit menu choice:**
- "set up autopilot for <repo>" / "drive these handoffs" → workflows/bootstrap-new-roadmap.md
- "the peer I just spawned, take it over" → workflows/attach-to-running-peer.md
- "the chain is stuck / failed / halted" → workflows/resume-halted-chain.md
- "what's the autopilot doing" / "is it still running" → workflows/audit-chain-state.md

After reading the workflow, follow it exactly.
</routing>

<reference_index>
- `references/architecture.md` — supervisor.py tick loop, state machine, components, cron contract
- `references/state-schema.md` — state.json shape, valid values, history record format
- `references/config-schema.md` — config.json shape: repo_path, forbidden_paths, exception_slices, verification_commands, merge_strategy
- `references/merge-detection.md` — direct ancestry vs git cherry patch-id, why both exist, edge cases
- `references/auto-review-policy.md` — what auto-review checks, forbidden-touch matrix, slice-specific overrides
- `references/halt-recovery.md` — common halt reasons (verification fail, forbidden touch, gh failure, preflight) + recovery steps
- `references/notion-creds-lookup.md` — fetching Telegram bot_token + chat_id from a Notion credentials page
- `references/responder-commands.md` — Telegram commands the responder accepts and how to add your own
</reference_index>

<workflows_index>
- `workflows/bootstrap-new-roadmap.md` — full setup from zero
- `workflows/attach-to-running-peer.md` — register an existing peer as the chain's current slice
- `workflows/resume-halted-chain.md` — diagnose and clear halt
- `workflows/audit-chain-state.md` — inspect the current chain's state and recent activity
</workflows_index>

<assets_index>
**Scripts** (in `scripts/`):
- `supervisor.py` — the brain; reads config.json + state.json, ticks once, exits. Designed for cron `*/5 * * * *`.
- `notify.sh` — Telegram sendMessage wrapper, reads creds from `<state-dir>/secrets/telegram.env`.
- `responder.py` — Telegram poller that listens for `/help`, `/status`, `/halt`, `/resume`, `/log`, `/peers`, `/kill`, `/cleanup` commands from the configured chat and replies. Designed for cron `* * * * *` with built-in 10s long-poll.

**Templates** (in `templates/`):
- `peer-prompt.template` — substituted with `{{SLICE_ID}}`, `{{SLICE_TITLE}}`, `{{MERGE_BRANCH}}` and passed to every spawned peer.
- `handoffs.tsv.example` — TSV format reference: `slice_id\ttitle\tmerge_branch\tmodel\tyolo`.
- `config.json.example` — config.json reference with all required fields populated.
</assets_index>

<success_criteria>
Skill is correctly invoked when:
- The user describes a multi-slice peer chain they want driven autonomously, and the bootstrap workflow scaffolds a working state dir + cron entry.
- An already-running peer can be wrapped into a new chain via attach-to-running-peer without spawning a duplicate.
- A halted chain can be diagnosed and resumed without losing event-dedupe state.
- The autopilot survives Claude session ending; cron continues to drive the chain.
- Every state transition produces exactly one Telegram message.
</success_criteria>
