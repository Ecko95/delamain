# Phase 3 Context: Self-Healing Peer Supervisor

Design sketch from ideation session (2026-07-08). Source of truth for discuss/plan.

## Shape

A healer loop (daemon or supervisor tick) watching the peer store for transitions into bad terminal states, classifying the failure, and applying per-class remediation with a retry budget.

Existing hooks: peer states `waiting`/`done`/`failed` (src/runner.ts:188, src/cursorRunner.ts:181), integration statuses `pending`/`skipped`/`pushed`/`failed` (src/types.ts:22), `send_peer_reply`, and one existing hard-coded heal case — Codex auth-refresh failure detection (src/runner.ts:216). This phase generalizes that one case into a classify-and-dispatch table.

## Failure classes and remediations

1. **failed + auth-refresh signature** — already detected. Heal: refresh auth, respawn same task.
2. **integrationStatus: failed (merge conflict / push rejection)** — work succeeded, landing failed. Heal: spawn a fresh peer tasked with "rebase branch X onto merge branch and resolve conflicts" plus original task context. Blast radius: one worktree.
3. **failed (task error)** — cheap-model (Haiku) classification of log tail: environment problem vs task problem. Environment → fix env, respawn verbatim. Task → respawn ONCE with failure diagnosis appended to prompt.
4. **waiting (peer question)** — triage: answerable from task spec/repo state → auto-reply via send_peer_reply; genuine scope decision → escalate to human. Highest expected wall-clock recovery.
5. **silent/stalled** (running, no log output for N minutes) — kill, mark, report. No auto-retry (stalls are usually systemic).

## Trust rules (non-negotiable)

- Every heal action logged with evidence: state, log excerpt, classification, action taken.
- Per-class escalation ceiling: max 1 retry per peer lineage, then page human with diagnosis. No retry storms.
- "Earn autonomy per problem type" — classes can be individually enabled/disabled; dry-run mode default for new classes.

## v1 scope

`healer.ts` with classify-and-dispatch table + retry-budget field on peer record. Interesting engineering: failure classifier (class 3) and question triager (class 4) — each a single Haiku call with log tail as context. Everything else is existing primitives (spawn/reply/kill/store).

## Research grounding (from 2026 landscape research)

- UC Berkeley MAST study: 41–87% agent task failure rates; step repetition top category (15.7%) — motivates retry ceilings.
- Cleric's "earn autonomy per problem type" model is the trust pattern to mirror at solo scale.
- Circuit-breakers/action budgets between agent and write path are the documented gap even in funded AI-SRE deployments.
