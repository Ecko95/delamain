# DevOS Recommendation Plan for GSD-Flow Phase Batches

## Status

Recommendation plan for the current DevOS project.

## Date

2026-05-10

## Goal

Add a DevOS-side implementation of the same GSD-flow phase-batch model used by `codex-mcp-peers-server`, but backed by Claude Code sessions and DevOS dispatch infrastructure.

The target user flow is:

```text
open DevOS milestone -> inspect phases -> select range -> launch Claude phase batch -> watch progress -> review worktree -> integrate -> launch next batch
```

DevOS should remain a monitoring and orchestration cockpit. The compliant execution runtime for Get Shit Done v1 should remain Claude Code, not the Claude Agent SDK.

## Current DevOS Findings

DevOS already has most of the substrate needed for this:

- Tauri command layer in `src-tauri/src/commands/gsd.rs`.
- Dispatch types in `crates/devos-core/src/dispatch/types.rs`.
- Dispatch orchestration in `crates/devos-core/src/dispatch/orchestrator.rs`.
- Worktree isolation in `crates/devos-core/src/dispatch/worktree_registry.rs`.
- State watching in `crates/devos-core/src/dispatch/state_watcher.rs`.
- API routes in `crates/devos-core/src/daemon_api/routes.rs`.
- GSD v1 adapter logic in `src-tauri/src/adapters/v1.rs`.
- Chain summary parsing in `src-tauri/src/chain_summary/`.

Important existing behavior:

- DevOS documentation treats `/gsd:autonomous` inside Claude Code as the primary GSD v1 workflow.
- `launch_gsd_auto` rejects GSD v2 Claude Agent SDK execution for Anthropic TOS reasons.
- The local Tauri command can launch Claude Code in tmux.
- The daemon dispatch system can clone repos, create worktrees, run jobs, capture artifacts, and push results.
- Existing dispatch modes are `Autonomous`, `SinglePhase`, and `PlanOnly`.
- Existing dispatch phase IDs are mostly `u32`, while the Tauri GSD v1 adapter already supports decimal phase IDs as strings.
- Current daemon `SinglePhase` with `DispatchEngine::Cli` uses `/gsd-autonomous --only`.
- Current daemon SDK autonomous command uses `gsd-sdk auto --from 1`.
- Current auto-push logic appears to commit from the clone path even when a worktree path is the effective execution path.

## Recommendation Summary

DevOS should add a `PhaseBatch` dispatch mode and make it the Claude equivalent of Codex GSD peer batches.

The DevOS implementation should:

- Use Claude Code CLI through tmux or daemon dispatch.
- Expand selected ranges into exact phase IDs before launch.
- Run `/gsd:autonomous --only <phase>` sequentially for each selected phase.
- Require worktree isolation by default.
- Track status from `.planning/` artifacts and chain-summary logic.
- Default to manual review rather than auto-push.
- Add an explicit integrate action for completed batch worktrees.

## Design Decisions

1. Keep `/gsd:autonomous` as the primary runtime for Claude-side GSD v1.
2. Do not add Claude Agent SDK execution for this workflow.
3. Add phase-batch dispatch as a new mode rather than overloading `SinglePhase`.
4. Keep existing dispatch API fields backward compatible.
5. Introduce string phase IDs for new phase-batch APIs.
6. Default phase batches to worktree isolation.
7. Default phase batches to manual review.
8. Use sequential `/gsd:autonomous --only <phase>` commands to avoid milestone lifecycle side effects.
9. Share one GSD artifact interpretation model between daemon jobs and Tauri UI.

## Public Interface Changes

Extend dispatch mode:

```rust
pub enum DispatchMode {
    Autonomous,
    SinglePhase,
    PhaseBatch,
    PlanOnly,
}
```

Add phase ID and range types:

```rust
pub struct PhaseId(pub String);

pub struct PhaseRange {
    pub from: PhaseId,
    pub to: PhaseId,
    pub selected_phases: Vec<PhaseId>,
}
```

Add completion policy:

```rust
pub enum CompletionPolicy {
    AutoPush,
    ManualReview,
}
```

Extend dispatch job:

```rust
pub struct DispatchJob {
    pub phase_range: Option<PhaseRange>,
    pub completion_policy: CompletionPolicy,
    pub review_worktree_path: Option<PathBuf>,
}
```

Backward compatibility:

- Keep `phase: Option<u32>` for current `SinglePhase` requests.
- Existing `mode: "single_phase"` requests should continue to work.
- Existing full autonomous dispatch behavior should remain unchanged.
- New `mode: "phase_batch"` should use the new `phase_range`.

## API Changes

Add an inspection endpoint:

```text
POST /api/v1/dispatch/inspect-gsd
```

Request:

```json
{
  "repo": "https://github.com/org/repo",
  "branch": "main",
  "from_phase": "1",
  "to_phase": "3"
}
```

Response:

```json
{
  "repo": "https://github.com/org/repo",
  "branch": "main",
  "phases": [
    {
      "id": "1",
      "title": "Example",
      "status": "ready",
      "has_context": true,
      "has_plan": false,
      "ready_for_batch": true,
      "warnings": []
    }
  ],
  "selected_phases": ["1", "2", "3"],
  "can_dispatch": true,
  "blocking_reasons": [],
  "warnings": []
}
```

Extend dispatch create:

```json
{
  "repo": "https://github.com/org/repo",
  "branch": "main",
  "mode": "phase_batch",
  "engine": "cli",
  "phase_range": {
    "from": "1",
    "to": "3"
  },
  "completion_policy": "manual_review",
  "isolation_mode": "worktree"
}
```

Add explicit integration:

```text
POST /api/v1/dispatch/{job_id}/integrate
```

Integration should:

- Refuse unfinished jobs.
- Refuse failed jobs unless forced by a future explicit option.
- Commit from the effective worktree path.
- Merge into the target branch.
- Push only during this explicit call.
- Mark the job result as integrated.

## Tauri Command Changes

Add local commands for non-daemon use:

```rust
inspect_gsd_phase_batch(repo_path, from_phase, to_phase)
launch_gsd_phase_batch(repo_path, repo_slug, unit_id, from_phase, to_phase, completion_policy, mcp_config_path)
```

`launch_gsd_phase_batch` should:

- Validate repo path.
- Validate optional MCP config path using the existing safe-path logic.
- Inspect selected phases before launch.
- Create or reuse a tmux session name consistent with current DevOS naming.
- Launch Claude Code with a generated batch prompt.
- Return session ID, selected phases, and initial tracking metadata.

## Claude Batch Prompt

The generated Claude prompt should include:

```text
You are running a DevOS phase batch for Get Shit Done v1.

Selected phases:
- 1
- 2
- 3

For each phase, run:
/gsd:autonomous --only <phase>

After each phase:
- verify expected .planning artifacts changed
- record blockers or human-input needs
- continue only when the phase command completes cleanly

Do not:
- run milestone lifecycle
- archive or cleanup the milestone
- push
- merge
- hide auth/model/.planning conflicts

At the end:
- summarize changed artifacts
- summarize changed source files
- identify the next recommended phase
- leave the worktree ready for DevOS review
```

## Dispatch Orchestrator Changes

Update `build_exec_command`:

- `DispatchMode::PhaseBatch` with `DispatchEngine::Cli` should build a Claude Code prompt that runs selected phases with `/gsd:autonomous --only`.
- `DispatchMode::PhaseBatch` with `DispatchEngine::Sdk` should be rejected at first unless there is a verified SDK equivalent that preserves the same lifecycle boundaries.
- `DispatchMode::SinglePhase` can keep current behavior.

Update job lifecycle:

- Run inspect after clone and before execution.
- Force or default `isolation_mode = "worktree"` for phase batches.
- Store selected phases in job state.
- Store the effective repo path separately from the clone path.
- Capture artifacts from the effective repo path.
- Skip `commit_and_push` when completion policy is `ManualReview`.
- For `AutoPush`, commit and push from the effective repo path, not always the clone path.
- Return `integration_status: "ready_for_review"` for manual-review completions.

## State and Artifact Tracking

The current `state_watcher.rs` is too root-`STATE.md` focused for reliable phase-batch tracking.

Recommended changes:

- Change phase identifiers in progress events from `u32` to string IDs for new events.
- Keep legacy numeric fields only where needed for existing UI compatibility.
- Watch `.planning/` recursively or add a polling artifact inspector.
- Track these files as status signals:
  - `.planning/STATE.md`
  - `.planning/HANDOFF.json`
  - `.planning/ROADMAP.md`
  - phase `*-CONTEXT.md`
  - phase `PLAN.md`
  - phase review files
  - phase verification files
- Reuse or move the existing `src-tauri/src/chain_summary/` parsing model into a shared core module so daemon and Tauri UI agree.
- Debounce partial writes and retry unreadable files before marking a job failed.

Progress mapping:

| Artifact signal | DevOS stage |
|---|---|
| Context file exists or changed | discuss |
| PLAN exists or changed | plan |
| source changes detected | execute |
| REVIEW exists or changed | review |
| VERIFICATION exists or changed | verify |
| HANDOFF exists or changed | handoff |
| selected phases complete | ready for review |

## UI Changes

Add a phase-batch action to the milestone view:

- Display phases from the current GSD roadmap.
- Show readiness markers for context, plan, review, and verification.
- Let the user choose `from` and `to`.
- Preview the exact selected phase list.
- Show blockers before launch.
- Launch a Claude phase batch.

Add a dispatch/job card state:

- `Running phase batch`
- current phase
- current GSD step
- selected phase list
- latest artifact event
- worktree path
- `Ready for review`
- `Integrate` action

Add review affordances:

- open worktree
- show changed files
- show phase artifacts
- integrate
- abandon or cleanup worktree

## Implementation Tasks

### Task 1: Add Phase-Batch Types

Files likely touched:

- `crates/devos-core/src/dispatch/types.rs`
- `crates/devos-core/src/dispatch/validation.rs`
- API serialization tests

Acceptance criteria:

- `mode: "phase_batch"` parses correctly.
- `phase_range.from` and `phase_range.to` accept decimal-safe strings.
- Existing dispatch requests remain compatible.

### Task 2: Add GSD Milestone Inspector

Files likely touched:

- new `crates/devos-core/src/gsd_flow/`
- `crates/devos-core/src/lib.rs`
- daemon API route tests

Acceptance criteria:

- Inspection reads cloned or local `.planning` state without mutating it.
- Ordered phases are returned.
- Selected ranges are expanded.
- Missing required artifacts produce blockers.

### Task 3: Add Inspect API

Files likely touched:

- `crates/devos-core/src/daemon_api/routes.rs`
- `crates/devos-core/src/daemon_api/server.rs`

Acceptance criteria:

- `POST /api/v1/dispatch/inspect-gsd` returns readiness.
- Invalid repos, branches, and phase IDs are rejected.
- Response is stable enough for UI use.

### Task 4: Add Claude Phase-Batch Command Builder

Files likely touched:

- `crates/devos-core/src/dispatch/orchestrator.rs`
- tests around `build_exec_command`

Acceptance criteria:

- CLI engine builds a Claude Code prompt.
- Prompt contains sequential `/gsd:autonomous --only` commands.
- SDK engine is rejected for phase-batch mode until explicitly supported.

### Task 5: Update Worktree and Integration Lifecycle

Files likely touched:

- `crates/devos-core/src/dispatch/orchestrator.rs`
- `crates/devos-core/src/dispatch/git_ops.rs`
- `crates/devos-core/src/dispatch/worktree_registry.rs`

Acceptance criteria:

- Phase batches default to worktree isolation.
- Manual-review jobs do not push.
- Auto-push jobs use the effective repo path.
- Completed manual-review jobs retain enough metadata for later integration.

### Task 6: Add Integrate Endpoint

Files likely touched:

- `crates/devos-core/src/daemon_api/routes.rs`
- `crates/devos-core/src/dispatch/orchestrator.rs`
- `crates/devos-core/src/dispatch/git_ops.rs`

Acceptance criteria:

- Integration rejects running jobs.
- Integration commits, merges, and pushes only when explicitly called.
- Integration updates persisted job state.

### Task 7: Upgrade Artifact Watcher

Files likely touched:

- `crates/devos-core/src/dispatch/state_watcher.rs`
- possible shared `gsd_flow` artifact parser
- watcher tests

Acceptance criteria:

- String phase IDs are supported for phase-batch events.
- Recursive artifact changes update progress.
- `STATE.md` lag does not freeze the UI when phase artifacts are moving.

### Task 8: Add Tauri Commands

Files likely touched:

- `src-tauri/src/commands/gsd.rs`
- `src-tauri/src/commands/mod.rs`

Acceptance criteria:

- Local inspect command returns the same readiness model as daemon inspect.
- Local launch command starts Claude Code in tmux with the phase-batch prompt.
- Existing `launch_gsd_auto` behavior remains unchanged.

### Task 9: Add Frontend Flow

Files likely touched:

- milestone/feed UI components
- dispatch/job state store
- command bindings

Acceptance criteria:

- User can inspect a milestone and select a phase range.
- User sees blockers before launch.
- Running jobs show current phase and current GSD step.
- Completed jobs expose review and integrate actions.

### Task 10: End-to-End Validation

Files likely touched:

- Rust integration tests
- frontend command tests where available
- fixture GSD repo

Acceptance criteria:

- A fixture repo dispatches a phase batch in worktree mode.
- No push occurs before integration.
- Artifacts are captured from the worktree.
- Integration pushes the reviewed result.

## Verification Commands

Expected Rust checks:

```bash
cargo test -p devos-core dispatch
cargo test -p devos-core daemon_api
cargo test -p devos-core gsd_flow
```

Expected Tauri checks:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npm run build
```

Expected manual verification:

```text
1. Open a repo with .planning/ROADMAP.md and .planning/STATE.md.
2. Inspect phases 1..2.
3. Launch a Claude phase batch with manual review.
4. Confirm tmux session runs Claude Code.
5. Confirm phase artifacts update in DevOS.
6. Confirm no push occurs.
7. Trigger integrate.
8. Confirm reviewed changes push to target branch.
```

## Risks

| Risk | Impact | Recommendation |
|---|---|---|
| Claude auth unavailable in tmux/container | High | Preflight Claude Code availability and auth before launch |
| GSD SDK behavior diverges from Claude skill behavior | High | Use Claude Code CLI for phase batches first; reject SDK until verified |
| Existing `u32` phase IDs break decimal phases | High | Use string phase IDs for all new phase-batch APIs |
| Worktree auto-push commits the wrong path | High | Use effective repo path for all artifact capture and integration |
| `STATE.md` lags artifact changes | Medium | Use recursive artifact polling and chain summary parsing |
| Milestone lifecycle runs inside batch | High | Use sequential `/gsd:autonomous --only` commands |
| UI implies work is merged when it is only ready for review | Medium | Add explicit `ready_for_review` and `integrated` states |

## Acceptance Criteria

- DevOS can inspect a GSD milestone and return an ordered, decimal-safe phase list.
- DevOS can launch a Claude Code phase batch for a selected range.
- Phase batches run in isolated worktrees by default.
- Phase batches execute selected phases sequentially with `/gsd:autonomous --only`.
- DevOS tracks current phase and GSD stage from artifacts.
- Manual-review jobs do not push.
- Explicit integration commits, merges, and pushes from the correct worktree.
- Existing autonomous, single-phase, and plan-only dispatch behavior remains compatible.

## Recommended Rollout

1. Implement core types and inspect behavior first.
2. Add daemon phase-batch dispatch without UI.
3. Add manual integration endpoint.
4. Upgrade watcher and artifact parsing.
5. Add local Tauri launch command.
6. Add UI controls once the daemon contract is stable.
7. Validate against a throwaway GSD milestone before using on active projects.
