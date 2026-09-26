---
name: delamain-orchestrate
description: Turn an OpenGSD roadmap (or a multi-part goal) into a delamain workflow that runs slices in parallel worktrees, one branch and PR per slice, ultracode-style. Use when the user wants several GSD phases or independent pieces of work built at once through delamain, says "orchestrate this roadmap", "run these phases in parallel", "branch per slice", or wants Codex to drive delamain instead of doing the work itself.
---

# delamain orchestrate

You are the orchestrator, not the implementer. You write **two files** into the target repo, hand them to delamain, and supervise. delamain's workflow engine owns the control flow (waves, concurrency, budget, timeout) so the run always terminates; each slice is a Codex peer in its own worktree that lands on its own branch and PR.

Files you produce, both under `<repo>/.delamain/orchestrate/`:

1. `<slug>.plan.json` — the decomposition (schema: `references/plan-schema.md`, example: `templates/plan.example.json`).
2. `<slug>.workflow.ts` — a copy of delamain's shipped `workflows/gsd-slices.ts`. Copy it unchanged unless the user asks for custom control flow; the copy is what gets committed and re-run.

## Why slices, not `/gsd-autonomous` per branch

GSD phases are stateful: every phase run rewrites `.planning/STATE.md`. Running `/gsd-autonomous` in parallel worktrees forks that state. So each slice leaf implements its phase **from the committed PLAN.md as the spec** with `.planning/` read-only, and one `finalize` leaf reconciles `.planning/` after the PRs merge. Never put `/gsd-autonomous` or `/gsd-execute-phase` in a slice prompt.

## Prerequisites

- delamain MCP tools available (`run_workflow`, `workflow_status`, `workflow_events`, `integrate_peer`, `inspect_gsd_milestone`) or the `delamain` CLI on PATH.
- `gh` authenticated for the repo (PRs are opened by `integrate_peer`).
- For GSD mode: the target repo has `.planning/` with per-phase PLAN.md files committed on the start ref. Phases without a plan are not runnable as slices.

## Intake

Collect these before writing anything (ask only for what is not already explicit):

1. **Repo path** (absolute) and whether it is an OpenGSD repo (`.planning/` present).
2. **Scope**: which phases (GSD) or which pieces of work (goal mode). In goal mode you decompose the goal yourself into independent slices.
3. **Merge branch**: bare origin branch name every PR targets (default: origin default branch).
4. **Start ref**: where wave-0 worktrees start (default `origin/<mergeBranch>`).
5. **Engine/model** default for slices (e.g. `codex` + `gpt-6-sol`).
6. **Concurrency**: max leaves alive at once (default 4; delamain peers are heavyweight).
7. **Verification jury**: 0 (default) or 3 jurors with lenses.

## Step 1 — Inspect the roadmap

GSD repo: call `inspect_gsd_milestone` (needs the repo URL) or read `.planning/ROADMAP.md` and the phase directories locally. A phase is a slice candidate only when `has_plan` is true. Note `has_frozen_contract` phases — they get their contract path added to `planPaths`.

Decide dependencies from the roadmap. **At most one `dependsOn` per slice** (a leaf can start from only one upstream branch). Prefer no dependencies; dependent slices start from the upstream slice's pushed branch and their PR diff shrinks once the upstream PR merges.

## Step 2 — Write the plan

Write `<repo>/.delamain/orchestrate/<slug>.plan.json` per `references/plan-schema.md`. For each slice:

- `prompt`: the task in your own words (what, not how). For GSD: "Implement phase 03 as specified in its PLAN.md".
- `planPaths`: the PLAN.md (and contract) paths, relative to the repo root.
- `acceptance`: observable outcomes lifted from the plan's success criteria.
- `verification`: `npx` commands scoped to the slice's files (never `npm run`).

Check the plan against the schema before launch: unique ids, at most one dependency per slice, no cycles, every slice has `title` and `prompt`, every `planPaths` entry exists on the start ref. The workflow re-validates and throws before spawning anything, but a failed launch still costs a round trip.

## Step 3 — Copy the workflow

```bash
mkdir -p <repo>/.delamain/orchestrate
cp "$(dirname "$(readlink -f "$(command -v delamain)")")/../workflows/gsd-slices.ts" <repo>/.delamain/orchestrate/<slug>.workflow.ts
```

If `delamain` is run from a checkout, copy from `<delamain checkout>/workflows/gsd-slices.ts`. Commit both files to the repo (they are the record of the run).

## Step 4 — Confirmation gate

Always confirm before launching:

```text
Confirm delamain orchestration:
- Repo: <repo>
- Plan: <repo>/.delamain/orchestrate/<slug>.plan.json (<n> slices, <k> waves)
- Slices: <id — title> ... (mark dependent ones with "← <upstream id>")
- Merge target: origin/<mergeBranch>; start ref: <startRef>
- Engine/model: <engine>/<model>; max concurrent leaves: <n>
- Jury: <off | 3 jurors, lenses ...>
- Guards: max-agents <n>, budget <tokens>, timeout <minutes>m

Proceed?
```

Guard formula: `max-agents = slices × (1 + jurors) + 2`; `budget-tokens ≈ 400k × slices × (1 + 0.3 × jurors)`; `timeout-ms = 45 min × waves` (minimum 30 min). State these numbers; the user may raise them.

## Step 5 — Launch

```bash
delamain run-workflow <repo>/.delamain/orchestrate/<slug>.workflow.ts \
  --repo <repo> --name "<plan name>" \
  --args-json "$(cat <repo>/.delamain/orchestrate/<slug>.plan.json)" \
  --max-agents <n> --budget-tokens <n> --timeout-ms <ms> --detach
```

Or via MCP: `run_workflow({ script_path, repo, name, args: <plan object>, max_agents, budget_tokens, timeout_ms })` — `args` is the plan object itself (not a string). Record the returned `workflow_id` in the plan file under `"runs"` (append `{ "stage": "implement", "workflow_id": "...", "startedAt": "<from workflow_status>" }`).

## Step 6 — Supervise

- `workflow_status({ workflow_id })` for status/result; `workflow_events({ workflow_id, since })` or `delamain workflow <id> --events` for the live stream (`phase_start`, `agent_spawn`, `agent_done`, `agent_failed`, `workflow_end`).
- A leaf that ends `waiting` fails the slice (workflows are non-interactive). Re-run that slice alone with a tighter prompt rather than resuming the peer.
- `halted` means a guard tripped (timeout / max-agents / budget). Inspect the events, raise the guard, and `delamain run-workflow --resume <workflow_id>` — finished leaves replay from the journal, only unfinished ones re-run.
- `delamain workflow kill <id>` stops the runner and every leaf.

Do not poll in a tight loop; check when the user asks or roughly every 10–15 minutes of expected leaf time.

## Step 7 — Integrate (branch + PR per slice)

When the run is `done`, the result (`workflow_status` → `workflow.result`) has `slices[]` with each slice's `status`, `landed`, `branch` (`codex-peer/<peerId>`), `summary`, `verification`, `residualRisk`, and `verified` (jury verdict, if enabled), plus a ready-made `landed[]` — the slices that are done, actually committed files, and survived the jury. Only those get PRs:

1. Find each slice's peer id. Peer ids are in `workflow.agentPeerIds` (MCP `workflow_status`) or the `delamain workflow <id>` record; the leaf's display name is `wave-<n>:<id> · <title>` (the engine prefixes the wave phase), so match on that in `delamain list` / `peer_status`.
2. `integrate_peer({ peer_id })` → opens the PR into `<mergeBranch>` with auto-merge enabled.
3. Merge in wave order; a dependent slice's PR must merge after its upstream's.

A slice can be `done` with `landed: false` — the leaf committed nothing, so delamain skipped the push and there is no branch; the workflow downgrades it to `blocked`. Report every `blocked`, `failed`, `skipped`, or jury-refuted slice (including `verified.jurors: 0`, which means nobody voted, not approval) to the user with the leaf's summary/error and propose a re-run plan for just those slices (a new plan file with only them; unchanged slices are not re-run). Never open a PR for a slice outside `landed[]` without the user's say-so.

## Step 8 — Finalize `.planning/` (GSD repos only)

After the slice PRs have merged, run the same workflow file once more with `"stage": "finalize"` and `"landed"` copied from the implement result:

```bash
jq '. + {stage: "finalize", landed: <landed from result>}' <slug>.plan.json > <slug>.finalize.json
delamain run-workflow <slug>.workflow.ts --repo <repo> --name "<plan name> · finalize" \
  --args-json "$(cat <slug>.finalize.json)" --max-agents 2 --timeout-ms 1800000 --detach
```

One leaf updates STATE.md and the phase SUMMARYs and pushes a branch; `integrate_peer` it like any other. The finalize leaf always starts from `origin/<mergeBranch>` (a pinned implement `startRef` is ignored) because it must see the merged PRs. Skip this stage in goal mode (no `.planning/`).

## Guardrails

- Never edit `.planning/` yourself and never let a slice do it; only the finalize leaf may.
- Never run more than one dependency deep without checking the upstream slice landed (`branch` present in the result).
- Never bypass the confirmation gate, and never launch without `--max-agents`, `--budget-tokens`, and `--timeout-ms`.
- Never merge a PR whose slice reported `blocked` or was refuted by the jury.
- Keep the plan and workflow files in the target repo, not in delamain's checkout.
