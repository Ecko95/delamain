# GSD-Flow Plan for codex-mcp-peers-server

## Status

Draft implementation plan.

## Date

2026-05-10

## Goal

Add a first-class Get Shit Done phase-batch workflow to `codex-mcp-peers-server` so Codex peers can execute a selected set of milestone phases in isolated worktrees, report progress asynchronously, and stop with reviewable outputs that the user can merge manually.

The system should stay simple at the user level:

```text
inspect milestone -> choose phase range -> spawn peer batch -> watch status -> review -> integrate -> run next batch
```

## Final Analysis

The current peer server is built around generic Codex process execution. It creates worktrees, starts `codex exec --json`, parses Codex event streams, tracks process and thread metadata, and currently supports automatic integration after successful peer completion.

That model is not enough for GSD phase batches because GSD progress is represented in `.planning/` artifacts, not Codex thread metadata. A GSD peer may complete useful work even if no Codex thread ID is available, and an asynchronous dashboard needs to understand milestone phase state, not just process state.

The important design shift is to treat Codex as the runtime and GSD artifacts as the source of truth.

Key implementation facts from the current repo:

- `src/runner.ts` starts `codex exec --json` and depends on Codex event parsing.
- `src/peerManager.ts` currently tracks `threadId`, `codexPid`, resume behavior, and automatic integration.
- `src/git.ts` already has worktree creation and merge/push integration primitives.
- `src/mcpServer.ts` currently exposes generic peer tools only.
- `src/types.ts` has generic peer status and integration state, but no GSD phase concepts.
- The dashboard already has status concepts that can map cleanly to GSD phase-batch status.

The GSD test-run analysis showed:

- `get-shit-done` and `gsd-sdk` should be version-aligned before relying on SDK behavior.
- `gsd-sdk auto --init` creates `.planning/` gradually and `STATE.md` can lag live execution.
- `HANDOFF.json` is optional and should not be required for status.
- `$gsd-autonomous --from N --to M` is closer than `gsd-sdk auto` for bounded phase work, but it can still blur into lifecycle behavior at milestone boundaries.
- The safer default for peer batches is to expand the selected range into exact phase IDs and run `$gsd-autonomous --only <phase>` sequentially for each selected phase.

## Design Decisions

1. Add GSD-specific tools instead of changing the behavior of existing generic peer tools.
2. Keep the public generic MCP surface backward compatible.
3. Use isolated worktrees for all GSD phase batches.
4. Use manual review and explicit integration by default.
5. Use `.planning/` artifact inspection as the primary status source.
6. Use sequential `$gsd-autonomous --only <phase>` execution for batch safety.
7. Keep `HANDOFF.json` optional.
8. Do not require Codex thread IDs for GSD peer status.
9. Do not let a GSD peer push, merge, archive, or complete a milestone lifecycle automatically.

## Public Interface Changes

Add MCP tools:

```text
inspect_gsd_milestone
spawn_gsd_phase_batch
spawn_gsd_phase_batch_and_wait
integrate_peer
```

Add CLI commands:

```text
codex-peers gsd inspect
codex-peers gsd spawn
codex-peers gsd spawn-and-wait
codex-peers integrate
```

Keep existing tools unchanged:

```text
spawn_peer
spawn_peer_and_wait
preflight_peer
list_peers
wait_for_peer
peer_status
read_peer_log
send_peer_reply
kill_peer
cleanup_peer
```

## Proposed Types

Add a peer kind:

```ts
type PeerKind = "generic" | "gsd_phase_batch";
```

Add phase ID support:

```ts
type GsdPhaseId = string;
```

Use string phase IDs because GSD and DevOS already need decimal-safe phase identifiers such as `1.1` or `2.3`.

Add a phase-batch request shape:

```ts
interface SpawnGsdPhaseBatchOptions {
  repo: string;
  fromPhase: GsdPhaseId;
  toPhase: GsdPhaseId;
  startRef?: string;
  mergeBranch?: string;
  targetBranch?: string;
  model?: string;
  sandbox?: string;
  allowSmartDiscuss?: boolean;
  integrationMode?: "manual" | "auto";
}
```

Default values:

```text
allowSmartDiscuss = false
integrationMode = manual
startRef = origin/main
mergeBranch = main
targetBranch = generated peer branch
```

Extend peer records with:

```ts
interface GsdPeerMetadata {
  phaseRange: {
    from: GsdPhaseId;
    to: GsdPhaseId;
  };
  selectedPhases: GsdPhaseId[];
  currentPhase?: GsdPhaseId;
  currentGsdStep?: GsdStep;
  readinessWarnings: string[];
  integrationMode: "manual" | "auto";
  reviewWorktreePath?: string;
}
```

Add step status:

```ts
type GsdStep =
  | "inspect"
  | "discuss"
  | "plan"
  | "execute"
  | "review"
  | "verify"
  | "handoff"
  | "complete"
  | "unknown";
```

## GSD Inspection Behavior

`inspect_gsd_milestone` should:

- Resolve the repo path and start ref.
- Confirm the repo has `.planning/ROADMAP.md`.
- Confirm the repo has `.planning/STATE.md`.
- Parse ordered phase IDs from the roadmap and phase artifacts.
- Expand `fromPhase` and `toPhase` into an exact ordered phase list.
- Check whether each selected phase has enough context to run without interactive discussion.
- Report warnings for missing context, missing plans, stale state, and dirty working trees.
- Return a launchable summary without mutating the repo.

Expected response:

```ts
interface InspectGsdMilestoneResult {
  repo: string;
  milestoneTitle?: string;
  phases: Array<{
    id: GsdPhaseId;
    title?: string;
    status?: string;
    hasContext: boolean;
    hasPlan: boolean;
    hasVerification: boolean;
    readyForBatch: boolean;
    warnings: string[];
  }>;
  selectedPhases: GsdPhaseId[];
  canSpawn: boolean;
  blockingReasons: string[];
  warnings: string[];
}
```

Blocking conditions:

- No `.planning/ROADMAP.md`.
- No `.planning/STATE.md`.
- Requested phase does not exist.
- Requested range is empty or reversed.
- Missing phase context while `allowSmartDiscuss` is false.
- Existing peer worktree for the same phase range is active.

Warnings, not blockers:

- `HANDOFF.json` is missing.
- `STATE.md` appears stale.
- Some selected phases already have completed artifacts.
- The repo has unrelated dirty changes in the source checkout.

## Spawn Behavior

`spawn_gsd_phase_batch` should:

1. Run `inspect_gsd_milestone`.
2. Refuse to spawn if inspection has blocking reasons.
3. Create a sibling worktree from `startRef`.
4. Create a deterministic peer branch name such as:

```text
peer/gsd/<from>-to-<to>/<timestamp>
```

5. Generate a Codex prompt that includes:

```text
- selected phase IDs
- merge target
- strict no-push/no-merge instruction
- sequential $gsd-autonomous --only commands
- final handoff summary requirements
- risks to surface instead of hiding
```

6. Start Codex in the worktree.
7. Track process logs and `.planning/` artifacts.
8. Return immediately with peer ID, worktree path, selected phases, and initial status.

The generated prompt should explicitly require:

```text
Run the selected phases one at a time:
1. $gsd-autonomous --only <phase>
2. verify expected artifacts changed
3. move to the next phase

Do not run milestone lifecycle commands.
Do not run cleanup/archive.
Do not push.
Do not merge.
Do not hide auth, model, or existing .planning conflicts.
```

## Status Tracking

GSD peer status should be derived in this order:

1. Explicit process terminal state.
2. Recent `.planning/` artifact changes.
3. `STATE.md` status and stopped-at markers.
4. Phase artifact presence.
5. Optional `HANDOFF.json`.
6. Raw Codex event stream as diagnostic data only.

Dashboard status mapping:

| Peer status | GSD meaning |
|---|---|
| `starting` | Worktree and process are being created |
| `working` | Selected phase artifacts or logs are moving |
| `waiting` | GSD reports human input needed or asks for a decision |
| `idle` | Process alive but no recent artifact movement |
| `done` | All selected phases reached expected terminal artifacts |
| `failed` | Process failed or required artifacts are missing |
| `frozen` | No process, log, or artifact movement past threshold |
| `killed` | User terminated the peer |

`lastEvent` should be translated from GSD events:

| Source observation | `lastEvent` |
|---|---|
| Context file created | `discuss complete` |
| Plan file created | `plan complete` |
| Source changes plus phase manifest | `execute in progress` |
| Review file created | `review complete` |
| Verification file created | `verify complete` |
| Handoff summary written | `handoff ready` |
| Human-needed marker | `waiting for input` |

## Integration Behavior

GSD phase-batch peers default to manual integration.

`integrate_peer` should:

- Refuse if the peer is still running.
- Refuse if the peer failed without `--force`.
- Show or return changed files and commit summary.
- Commit remaining work in the peer worktree if needed.
- Merge into the configured merge branch.
- Push only during this explicit integration command.
- Mark peer integration status as `pushed` or `failed`.

Generic peers can keep existing automatic integration behavior unless explicitly changed later.

## Implementation Tasks

### Task 1: Add GSD Types

Files likely touched:

- `src/types.ts`
- tests for serialization and defaults

Acceptance criteria:

- Peer records distinguish generic peers from GSD phase batches.
- Phase IDs are strings.
- Existing generic peer records remain compatible.

### Task 2: Build GSD Milestone Inspector

Files likely touched:

- new `src/gsdInspect.ts`
- tests for roadmap and artifact parsing

Acceptance criteria:

- Inspection is read-only.
- Phase ranges expand to exact ordered phase IDs.
- Missing context blocks by default.
- Missing `HANDOFF.json` does not block.

### Task 3: Build GSD Prompt Generator

Files likely touched:

- new `src/gsdPrompt.ts`
- tests for generated prompt content

Acceptance criteria:

- Prompt uses sequential `$gsd-autonomous --only <phase>`.
- Prompt contains no-push/no-merge/no-cleanup requirements.
- Prompt includes selected phase list and merge target.

### Task 4: Add GSD Runner Mode

Files likely touched:

- `src/runner.ts`
- new `src/gsdState.ts`
- lifecycle tests

Acceptance criteria:

- Generic peers still use Codex JSON events.
- GSD peers use artifact polling for status.
- GSD peers do not require `threadId`.
- GSD peers can finish successfully without `HANDOFF.json`.

### Task 5: Add MCP and CLI Surfaces

Files likely touched:

- `src/mcpServer.ts`
- `src/cli.ts`
- README command docs

Acceptance criteria:

- New tools are discoverable through MCP.
- CLI mirrors MCP behavior.
- Existing tools retain their current schemas.

### Task 6: Add Manual Integration Flow

Files likely touched:

- `src/peerManager.ts`
- `src/git.ts`
- integration tests

Acceptance criteria:

- GSD phase-batch peers do not auto-push.
- `integrate_peer` performs explicit merge and push.
- Failed or running peers cannot integrate unless forced.

### Task 7: Update Dashboard Status

Files likely touched:

- `src/dashboard/model.ts`
- `src/dashboard/opentui.ts`
- dashboard tests

Acceptance criteria:

- GSD current phase and current step render clearly.
- Waiting and frozen states are distinguishable.
- Generic peer dashboard behavior remains unchanged.

### Task 8: Add End-to-End Verification

Files likely touched:

- new or existing integration test under `tests/`
- scripted throwaway repo fixture

Acceptance criteria:

- Test initializes a small GSD milestone fixture.
- Test spawns a phase-batch peer against a fake runner.
- Test verifies no push before manual integration.
- Test verifies status transitions and artifact detection.

## Verification Commands

Expected local verification:

```bash
npm test
npm run build
node tests/gsd-phase-batch.test.mjs
```

Expected manual verification:

```bash
codex-peers gsd inspect --repo /tmp/gsd-peer-fixture --from 1 --to 2
codex-peers gsd spawn --repo /tmp/gsd-peer-fixture --from 1 --to 2 --start-ref origin/main --merge-branch main
codex-peers list
codex-peers integrate <peer-id>
```

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Model or Codex auth unavailable in the peer worktree | High | Preflight should surface auth/model failures and stop early |
| Existing `.planning/` state conflicts with selected phase range | High | Inspection blocks ambiguous state unless explicitly overridden |
| `STATE.md` lags live execution | Medium | Use artifact polling plus process logs, not `STATE.md` alone |
| `HANDOFF.json` absent | Medium | Treat it as optional; use phase artifacts as canonical source |
| Direct `--from/--to` reaches milestone lifecycle | High | Use sequential `--only` by default |
| Auto-integration hides bad phase outputs | High | Manual review is default for GSD phase batches |

## Acceptance Criteria

- A user can inspect a milestone and see selectable phase readiness.
- A user can spawn one peer for phases `N..M`.
- The peer runs selected phases in order with isolated worktree changes.
- Dashboard status tracks current GSD phase and step asynchronously.
- Missing auth, existing `.planning/` conflicts, and exit-code ambiguity are surfaced explicitly.
- The peer never pushes or merges unless `integrate_peer` is called.
- After integration, the user can start the next phase batch from the merged result.
