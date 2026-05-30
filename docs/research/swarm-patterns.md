# Swarm Pattern Research

Research scope:
- Upstream repos reviewed with `gh api`.
- Local comparison points: `src/peerManager.ts` and `src/runner.ts`.
- LOC in the table below is estimated new code to port into this runner, not source-repo size.

## The three repos at a glance

| Repo | Stars | Push date | Language |
|---|---:|---|---|
| [hemishbiswas4-arch/codex-swarm-runtime](https://github.com/hemishbiswas4-arch/codex-swarm-runtime) | 0 | 2026-04-28 | Python |
| [cj-vana/claude-swarm](https://github.com/cj-vana/claude-swarm) | 109 | 2026-02-11 | TypeScript |
| [Iron-Ham/claudio](https://github.com/Iron-Ham/claudio) | 28 | 2026-04-21 | Go |

## Ralph loop (cj-vana)

Exact mechanism:
- `src/workers/ralph-loop.ts:46-191` builds a shell loop that launches a fresh Claude session on every iteration.
- Each pass re-reads `progress.md`, injects current git diff/log state, and writes progress back to the filesystem.
- Completion is signaled with a `.done` file; stopping conditions are max iterations, max duration, or completion marker.
- `README.md:35-40` and `README.md:79-87` describe the same loop at the product level: fresh context per iteration, filesystem state, and git history as the memory substrate.

How it fights context rot:
- It does not try to preserve a single long-lived chat context.
- The next iteration reconstructs state from files and git history, so each run starts clean and only rehydrates the minimum needed context.
- That makes it robust for long sessions where a single session would drift or lose detail.

Code pointers:
- `README.md:35-40, 79-87`
- `src/workers/ralph-loop.ts:46-191`
- `src/workers/ralph-loop.ts:198-256` for progress-file parsing

Cost of port to our runner:
- Estimated port size: `~150-220 LOC`
- Dependencies: iteration scheduler, progress-file schema, completion marker, fresh prompt builder, and a handoff/reload path between iterations.
- Risk: medium. The mechanics are simple, but it can overlap with the runner’s existing process model if we do not define what “one iteration” means relative to `spawnPeer` and `resumePeer`.

Local comparison:
- Our runner already spawns a fresh process per peer and builds a fresh prompt in `src/runner.ts:46-87` and `src/runner.ts:246-265`.
- That means Ralph loop is less about process plumbing here and more about adding explicit iteration state and re-entry semantics.

## TripleShot (Iron-Ham)

Exact mechanism:
- `docs/guide/tripleshot.md:1-147` defines the workflow: three parallel attempts on the same task, then a fourth judge instance evaluates them.
- Each attempt writes `.claudio-tripleshot-complete.json` with summary, files changed, and approach.
- The judge writes `.claudio-tripleshot-evaluation.json` with `winner_index`, `merge_strategy`, per-attempt scores, reasoning, and suggested changes.
- The supported outcomes are `select`, `merge`, or `combine`.

How the judge picks the winner:
- `internal/orchestrator/workflows/tripleshot/types.go:113-128` defines the evaluation schema, including `WinnerIndex` and per-attempt scores.
- `internal/orchestrator/workflows/tripleshot/coordinator.go:564-649` builds the judge prompt from all three attempt summaries and starts the judge instance.
- `internal/orchestrator/workflows/tripleshot/coordinator.go:1069-1111` parses the evaluation, validates `winner_index`, and selects the winner branch when the strategy is `select`.
- In adversarial mode, `internal/orchestrator/workflows/tripleshot/coordinator.go:755-830` inserts a reviewer loop before the judge; only attempts that pass review proceed.

Could we wire this with `engine: codex + cursor + codex` for a cross-engine vote?
- Yes, likely.
- Our local runner already stores the engine per peer in `src/peerManager.ts:48-87` and dispatches Codex vs Cursor in `src/runner.ts:30-43`.
- That makes a mixed-engine TripleShot variant feasible: spawn one Codex attempt, one Cursor attempt, and another Codex attempt, then let a judge peer normalize and compare outputs.
- This is an inference from the current engine abstraction, not something already implemented.
- The main caveat is score normalization: different engines may emit different artifact shapes, so the judge prompt needs a strict rubric and probably a shared evaluation schema.

Cost of port to our runner:
- Estimated port size: `~300-500 LOC`
- Dependencies: attempt coordination, judge/evaluation schema, winner application, and a merge/select policy.
- Risk: medium-high. It is useful, but it asks for a lot of orchestration logic, and cross-engine judging adds another layer of normalization risk.

## Watchdog repair injection (hemishbiswas)

Exact mechanism:
- `scripts/swarm_watchdog.py:131-224` samples run state on a cycle: latest run, active tasks, blocked tasks, last progress time, controller presence, and disk pressure.
- If the run is stalled with active tasks, it calls `_heal_stalled_active_run`.
- If the run is stalled without active completions, or blocked tasks are piling up, it injects a repair message instead of doing nothing.
- `_maybe_send_prompt` and the various `_maybe_nudge_*` helpers generate targeted repair prompts for specific roles and throttle them with per-cycle and cooldown guards.
- `_inject_message` in `scripts/swarm_watchdog.py:1147-1181` sends the message back through `python3 -m codex_swarm --message-run ...`.

Could it replace or augment our halt-on-failure path?
- Augment, not replace.
- Hard failures should still stop or fail fast.
- The watchdog pattern is better for recoverable stalls, blocked lanes, deadlocks, and underfilled implementation coverage.
- In other words: keep the halt path for terminal failure, add watchdog repair for non-terminal stagnation.

Code pointers:
- `README.md:64-69`
- `scripts/swarm_watchdog.py:131-224`
- `scripts/swarm_watchdog.py:305-390`
- `scripts/swarm_watchdog.py:397-770`
- `scripts/swarm_watchdog.py:1147-1181`
- `codex_swarm/controller.py:2263-2399` for deadlock repair tasks and recovery lane scheduling

Cost of port to our runner:
- Estimated port size: `~120-220 LOC`
- Dependencies: run-state snapshotting, stall detection, message injection API, and cooldown bookkeeping.
- Risk: low-medium. The surface area is narrow, and it composes well with the runner we already have.

## File-based atomic task locks (cj-vana)

Exact mechanism:
- `src/workers/lock-manager.ts:28-160` implements file locks under `.claude/orchestrator/locks`.
- It claims a file by atomically creating a `.lock` file with `O_CREAT | O_EXCL`.
- It can list locks, release all locks for a feature, and clear the directory.

When peers need mutex:
- If peers share a writable surface, locks prevent two workers from claiming the same files at the same time.
- If each peer has its own linked worktree, the need for mutex drops sharply because the file trees are already disjoint.

Do we need this if each peer has its own worktree?
- Usually no.
- Our current design already isolates peers in linked worktrees in `src/peerManager.ts:36-39`.
- Locks only become useful if we introduce shared mutable artifacts outside the worktree, or if multiple peers can touch a common integration directory or shared cache.

Cost of port to our runner:
- Estimated port size: `~80-140 LOC`
- Dependencies: lock directory, path normalization, atomic create/delete, cleanup path.
- Risk: low, but also low leverage unless we intentionally add shared writable state.

## Cost-of-implementation table

| Feature | Source repo | LOC | deps | risk |
|---|---|---:|---|---|
| Ralph loop | `cj-vana/claude-swarm` | `~150-220` | fresh iteration launcher, progress files, git-state rehydration, completion marker | medium |
| TripleShot judge | `Iron-Ham/claudio` | `~300-500` | attempt coordination, judge/evaluation schema, winner application, merge policy | medium-high |
| Watchdog repair injection | `hemishbiswas4-arch/codex-swarm-runtime` | `~120-220` | run snapshot polling, message injection, cooldown state, repair prompts | low-medium |
| File-based task locks | `cj-vana/claude-swarm` | `~80-140` | lock directory, atomic file creation, lock release/cleanup | low |

## Recommendation order

If we can only port 2 patterns:

1. Watchdog repair injection first.
2. TripleShot second, preferably with a mixed-engine judge experiment.

Why this order:
- Watchdog is the smallest lift with the biggest operational payoff. It addresses the runner’s weakest failure mode: stalling and deadlock recovery.
- TripleShot is the best quality multiplier. Our current runner already supports per-peer engine selection in `src/peerManager.ts:48-87` and `src/runner.ts:30-43`, so a cross-engine variant is plausible without redesigning the whole orchestrator.
- Ralph loop is useful, but our runner already launches fresh processes per peer, so the context-rot win is smaller here than in a single long-lived Claude session.
- File-based locks are last because linked worktrees already give us the main concurrency boundary.

## Sources

- `hemishbiswas4-arch/codex-swarm-runtime`: [README.md](https://github.com/hemishbiswas4-arch/codex-swarm-runtime/blob/main/README.md), [codex_swarm/repository.py](https://github.com/hemishbiswas4-arch/codex-swarm-runtime/blob/main/codex_swarm/repository.py), [codex_swarm/controller.py](https://github.com/hemishbiswas4-arch/codex-swarm-runtime/blob/main/codex_swarm/controller.py), [scripts/swarm_watchdog.py](https://github.com/hemishbiswas4-arch/codex-swarm-runtime/blob/main/scripts/swarm_watchdog.py)
- `cj-vana/claude-swarm`: [README.md](https://github.com/cj-vana/claude-swarm/blob/main/README.md), [src/workers/ralph-loop.ts](https://github.com/cj-vana/claude-swarm/blob/main/src/workers/ralph-loop.ts), [src/workers/lock-manager.ts](https://github.com/cj-vana/claude-swarm/blob/main/src/workers/lock-manager.ts), [src/protocols/schema.ts](https://github.com/cj-vana/claude-swarm/blob/main/src/protocols/schema.ts), [src/protocols/enforcement.ts](https://github.com/cj-vana/claude-swarm/blob/main/src/protocols/enforcement.ts), [src/workers/review-manager.ts](https://github.com/cj-vana/claude-swarm/blob/main/src/workers/review-manager.ts)
- `Iron-Ham/claudio`: [README.md](https://github.com/Iron-Ham/claudio/blob/main/README.md), [docs/guide/task-chaining.md](https://github.com/Iron-Ham/claudio/blob/main/docs/guide/task-chaining.md), [docs/guide/tripleshot.md](https://github.com/Iron-Ham/claudio/blob/main/docs/guide/tripleshot.md), [internal/orchestrator/workflows/tripleshot/coordinator.go](https://github.com/Iron-Ham/claudio/blob/main/internal/orchestrator/workflows/tripleshot/coordinator.go), [internal/orchestrator/workflows/tripleshot/types.go](https://github.com/Iron-Ham/claudio/blob/main/internal/orchestrator/workflows/tripleshot/types.go), [internal/orchestrator/workflows/tripleshot/session.go](https://github.com/Iron-Ham/claudio/blob/main/internal/orchestrator/workflows/tripleshot/session.go), [internal/orchestrator/workflows/adversarial/coordinator.go](https://github.com/Iron-Ham/claudio/blob/main/internal/orchestrator/workflows/adversarial/coordinator.go), [internal/orchestrator/budget/manager.go](https://github.com/Iron-Ham/claudio/blob/main/internal/orchestrator/budget/manager.go), [internal/team/budget.go](https://github.com/Iron-Ham/claudio/blob/main/internal/team/budget.go)
- Local comparison: [src/peerManager.ts](../../src/peerManager.ts), [src/runner.ts](../../src/runner.ts)
