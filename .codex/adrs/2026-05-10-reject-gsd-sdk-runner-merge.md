# ADR: Reject `feat/gsd-sdk-runner` as a merge-to-main candidate

**Status:** Decided — branch parked, do NOT merge to `main`.
**Date:** 2026-05-10
**Decision-makers:** Ecko95 (product owner) + Claude (implementer) + Codex MCP gpt-5.4 xhigh (external reviewer) + /gsd-explore (internal router)
**Supersedes:** none
**Superseded by:** none

## Context

Between 2026-05-09 and 2026-05-10 the `feat/gsd-sdk-runner` branch was built on this repo to swap the peer process backend from `codex exec --json` to `gsd-sdk auto`. The branch reached green CI (23/23 tests, type-check clean) and was end-to-end smoke-tested against a fake gsd-sdk shim. Three commits sit on the branch (not on main): `25e9b49`, `e53e01e`, `5ac4946`. The branch is preserved in the linked worktree at `~/dev/codex-mcp-peers-server-gsd-sdk`.

After the branch landed, two architectural plans were drafted (in this repo at `.codex/plans/20260510-gsd-flow-codex-mcp-peers-server.md` and `.codex/plans/20260510-gsd-flow-devos-recommendation.md`) that converged on a different shape (`gsd_phase_batch` MCP tools driving slash commands inside the host IDE, manual integration default, sequential `--only` per phase). A parallax review (Codex MCP critique + `/gsd-explore` Socratic routing) plus a 5-mapper codebase analysis of the canonical `get-shit-done` framework produced compounding evidence that merging this branch as-is would lock in the wrong shape.

Full record:
- DevOS-side parallax review: `~/dev/projects/devOS/.planning/reviews/2026-05-10-pre-planned-batch-architecture-review.md`
- DevOS-side gsd-explore routing: `~/dev/projects/devOS/.planning/explorations/2026-05-10-pre-planned-batch-exploration.md`
- DevOS-side codebase analysis: `~/dev/projects/devOS/.planning/codebase/get-shit-done/{TECH,ARCH,QUALITY,CONCERNS}.md`
- DevOS-side milestone plan: `~/dev/projects/devOS/.planning/IMPLEMENTATION-PLAN.md` (v8.0 PhaseBatch + FROZEN-CONTRACT)

## Decision

**Do not merge `feat/gsd-sdk-runner` into `main`.** Park the branch as a learning artifact. Future GSD-mode work on this repo will land on a separate `feat/gsd-phase-batch` branch (Phase 33 of the v8.0 milestone) using a different design.

## Rationale

Four load-bearing reasons, each with file:line evidence from the upstream `gsd-build/get-shit-done@1.50.0-canary.0` codebase as analyzed.

### 1. TOS exposure — `gsd-sdk auto` runs the Anthropic Agent SDK at runtime

The branch's runner spawns `gsd-sdk auto`, which embeds `@anthropic-ai/claude-agent-sdk.query()` execution at every phase step. DevOS already rejects Agent SDK execution on TOS grounds for the Claude side; adopting `gsd-sdk auto` transitively re-imports the same exposure.

Evidence (paths in the upstream `get-shit-done` repo):
- `sdk/src/session-runner.ts:8` — `import { query } from '@anthropic-ai/claude-agent-sdk';` (runtime import)
- `sdk/src/session-runner.ts:106-123` — `runPlanSession` calls `query({...})` with `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`
- `sdk/src/session-runner.ts:307-324` — `runPhaseStepSession` makes a second `query()` call with the same options
- `sdk/src/phase-runner.ts:362,470,550,795,855` — five `runPhaseStepSession` call sites in the phase state machine
- `sdk/src/runtime-gate.ts:42-51` — explicitly Claude-only: "gsd-sdk auto currently supports the Claude runtime only ... Autonomous terminal runs through the Claude Agent SDK"

The TOS-clean alternative (used in v8.0): `gsd-sdk query …` (Agent-SDK-free at `sdk/src/cli.ts:314-323`) for read-side state inspection, plus slash commands inside the host IDE agent loop for lifecycle.

### 2. Auto-integration on exit code 0 violates manual-review default

The branch's runner commits, merges, and pushes whenever the spawned `gsd-sdk auto` exits 0:
- `feat/gsd-sdk-runner:src/runner.ts:124-144` — `if (status === "done") { … integratePeerWorktree(args.repo, args.peerId, args.mergeBranch || "main") … }`

Both adjacent plans on `.codex/plans/20260510-*.md` decided on **manual integration as the default** for GSD-mode peers (decisions 4 and 9 in `20260510-gsd-flow-codex-mcp-peers-server.md`; decisions 7 and 9 in `20260510-gsd-flow-devos-recommendation.md`). The branch's auto-push directly contradicts this.

### 3. HANDOFF.json treated as a status signal

The branch's status detection polls `.planning/HANDOFF.json` for `human_actions_pending` and uses its presence/absence as the waiting/working signal:
- `feat/gsd-sdk-runner:src/gsdState.ts:47-65` — HANDOFF reader
- `feat/gsd-sdk-runner:src/gsdState.ts:179-200` — `snapshotPendingQuestion` + `reconcileFinishedWaitingPeer` rely on HANDOFF presence

The codebase analysis proves HANDOFF.json is not a phase artifact at all:
- HANDOFF.json is written exclusively by `/gsd-pause-work` (`get-shit-done/workflows/pause-work.md:2`)
- It is read once and **deleted** by `/gsd-resume-work` (`get-shit-done/workflows/resume-project.md:67-94`)
- No code path in `sdk/src/phase-runner.ts`, `sdk/src/init-runner.ts`, or `sdk/src/session-runner.ts` writes HANDOFF.json (zero grep hits in the SDK)
- `get-shit-done/references/artifact-types.md:47-50` categorizes it as a session artifact, not a phase artifact

The correct phase-boundary signal is STATE.md (always written by phase steps, queryable via the Agent-SDK-free `gsd-sdk query state-document`).

### 4. Replaces the generic Codex-exec runner instead of adding a GSD-specific peer kind alongside

The branch deletes `src/codexEvents.ts` and `src/lifecycle.ts` and rewrites `src/runner.ts` to spawn only `gsd-sdk`. This eliminates the codex-exec runner that powers existing generic peers.

The codex-mcp-peers GSD-flow plan (`.codex/plans/20260510-gsd-flow-codex-mcp-peers-server.md`, decision 1) explicitly requires a `PeerKind = "generic" | "gsd_phase_batch"` discriminator that **keeps the existing generic peer surface unchanged** and adds GSD-specific tools alongside. The branch's wholesale replacement is "a product fork, not a backend swap" (Codex review verbatim).

### 5. The runtime split was incoherent (smaller but still real)

`gsd-sdk auto` doesn't accept `--only` (verified at `sdk/src/cli.ts:21-46` — `ParsedCliArgs` has no `--only`/`--from`/`--to` fields), and the SDK's phase-runner has an auto-approve fallthrough that advances the milestone when no `onBlockerDecision` callback is wired:
- `sdk/src/phase-runner.ts:1021-1038` — runtime advance gate auto-approves when callback is missing
- `sdk/src/index.ts:164-166` — `auto` mode constructor force-sets `config.workflow.auto_advance = true`

The branch wraps `gsd-sdk auto` per peer with no `--only` (since the flag doesn't exist headlessly) and no `onBlockerDecision` callback. A peer can drift past intended phase boundaries silently.

## Salvage from the branch (re-use in v8.0 phases)

The branch contains code worth keeping. Future phases should cherry-pick from `~/dev/codex-mcp-peers-server-gsd-sdk` rather than re-write from scratch:

1. **`src/gsdState.ts` — STATE.md frontmatter parser**
   - SALVAGE: the `extractFrontmatter()` + `parseFrontmatter()` functions (lines 78-130 in the branch).
   - DISCARD: the HANDOFF.json reader (`readHandoff` lines 50-66, `snapshotPendingQuestion` lines 158-167) and `reconcileFinishedWaitingPeer` (lines 179-200) — these encode the wrong contract per Reason 3.
   - **Where it goes:** Phase 33 (codex-peers GSD mode). The status-read layer should read STATE.md via this parser OR via `gsd-sdk query state-document`. Prefer the latter where possible (it's the upstream-supported API).

2. **`src/util/text.ts` — `trim()` helper**
   - SALVAGE: trivially. Move to wherever the GSD peer's logging needs it in Phase 33.

3. **`tests/gsdState.test.mjs` — fake-shim integration test pattern**
   - SALVAGE: the pattern of putting a fake `gsd-sdk` shim on `PATH` and verifying STATE.md / HANDOFF.json side effects.
   - DISCARD: the specific HANDOFF.json reconciliation test cases (those test the wrong contract).
   - **Where it goes:** Phase 31 (3-phase fixture milestone). The fixture's CI / RECIPE.md can use this same pattern to inject the drift kill-test.

4. **The smoke-test recipe in `.codex/peer-handoffs/20260509-1726-gsd-sdk-runner-swap.md`**
   - SALVAGE: structure (init → spawn → tail STATE+HANDOFF → assert).
   - DISCARD: the `gsd-sdk auto` invocation step.

## Discard from the branch (do NOT bring forward)

1. **`src/runner.ts` `gsd-sdk auto` spawn path** — TOS-blocked per Reason 1.
2. **Auto-integration on exit code 0** — violates manual-review default per Reason 2.
3. **HANDOFF.json polling for status** — wrong contract per Reason 3.
4. **The wholesale replacement of `codexEvents.ts` and `lifecycle.ts`** — generic peers must keep working per Reason 4.
5. **The MCP schema deletions of `sandbox` / `yolo` / `dangerously_bypass_approvals_and_sandbox`** — those are still relevant to generic peers; only GSD peers should ignore them.

## Branch annotation

The branch `feat/gsd-sdk-runner` (HEAD `5ac4946`) is **preserved for reference, do not merge.** It remains in the linked worktree at `~/dev/codex-mcp-peers-server-gsd-sdk` so the salvage code can be cherry-picked when v8.0 phases land. Once Phase 33 has cherry-picked what it needs, the branch and worktree can be deleted (a follow-up cleanup phase, not in v8.0 scope).

## Consequences

**Positive:**
- TOS posture preserved on the Claude side. DevOS-managed peer dispatch never embeds `@anthropic-ai/claude-agent-sdk` at runtime.
- Generic peer flow keeps working unchanged.
- v8.0 phases inherit clear guidance on what to reuse vs re-implement.
- The 1.5 days of work that produced the branch is not wasted — concrete code is documented as cherry-pick candidates.

**Negative:**
- The work in the branch doesn't ship as-is. Future phases must extract the salvage parts deliberately.
- A linked worktree continues to occupy disk and namespace until Phase 33 completes the cherry-picks and a cleanup phase removes it.

**Neutral:**
- The original orchestrator handoff at `.codex/peer-handoffs/20260509-1726-gsd-sdk-runner-swap.md` remains accurate as the description of what the branch *did*; this ADR documents why we're not adopting it.

## References

- DevOS milestone plan v8.0: `~/dev/projects/devOS/.planning/IMPLEMENTATION-PLAN.md`
- DevOS integration findings: `~/dev/projects/devOS/.planning/codebase/INTEGRATION-FINDINGS.md`
- DevOS Codex MCP review: `~/dev/projects/devOS/.planning/reviews/2026-05-10-pre-planned-batch-architecture-review.md`
- DevOS gsd-explore routing: `~/dev/projects/devOS/.planning/explorations/2026-05-10-pre-planned-batch-exploration.md`
- DevOS canonical-GSD analysis: `~/dev/projects/devOS/.planning/codebase/get-shit-done/{TECH,ARCH,QUALITY,CONCERNS}.md`
- This repo's two adjacent plans: `.codex/plans/20260510-gsd-flow-codex-mcp-peers-server.md` and `.codex/plans/20260510-gsd-flow-devos-recommendation.md`
- Original handoff that produced the parked branch: `.codex/peer-handoffs/20260509-1726-gsd-sdk-runner-swap.md`
