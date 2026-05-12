---
name: codex-peers-worktree-routing
description: Prompt the orchestrator before spawning codex-peers with an explicit peer task, planned handoff file, worktree start ref, and origin merge branch; use when a user wants codex-peers to start from a chosen branch/ref/worktree and merge to a chosen origin branch.
---

# Codex Peers Worktree Routing

Use this skill before calling the `codex-peers` MCP tools when the peer's start point, merge target, or handoff quality matters.

Every peer handoff must be planned and written in advance inside the target repo's `.codex/peer-handoffs/` directory before spawning the peer. The handoff file is the source of truth for the peer prompt.

## Required Questions

Before spawning, collect these values from the orchestrator unless they were already explicit:

1. **Peer to spawn**: the task prompt for the Codex peer, plus the repo path if it is not obvious.
2. **Worktree start ref**: the git ref used to create the linked worktree.
   - Default to the repo's origin default branch as `origin/<branch>`.
   - If origin default is unavailable, offer `origin/main` first, then `origin/master`.
   - Accept examples like `origin/release`, a local branch, `HEAD`, or a commit SHA.
3. **Merge branch**: the origin branch that should receive successful peer changes.
   - Default to the same origin default branch, `main`, or `master`.
   - Store this as a bare branch name such as `main` or `release`, not `origin/main`.

## Handoff File Gate

Before confirmation and before spawning:

1. Create the target repo directory `.codex/peer-handoffs/` if it does not exist.
2. Write a handoff file named `<YYYYMMDD-HHMM>-<short-slug>.md`.
3. Keep the file in the target repo, not in the orchestrator's unrelated checkout.
4. Do not spawn until the handoff exists on disk and has been reviewed by the orchestrator.

Use this structure:

```markdown
# Codex Peer Handoff: <short title>

## Routing

- Repo: <absolute repo path>
- Start worktree from: <start_ref>
- Merge successful changes to: origin/<merge_branch>

## Task

<clear task statement>

## Context

<relevant code paths, docs, prior decisions, constraints>

## Instructions

- Work only on the task described here.
- Do not push, merge, or switch branches; codex-peers handles integration.
- Ask the orchestrator if blocked or if scope needs to change.

## Acceptance Criteria

- <observable outcome 1>
- <observable outcome 2>

## Verification

Use `npx <tool>` for all shell verification steps; never `npm run <script>`. Reason: `npm run` can resolve a stale global binary when `node_modules` is missing in a fresh worktree.

Good examples:
- `npx tsc -p tsconfig.json --noEmit`
- `npx vitest run src/changed-module/`
- `npx eslint src/changed-file.ts`

Scope test commands to the directories containing changed files; do not run the full suite unless the change is cross-cutting.

Before the first peer finishes, dry-run the verification commands in a clean worktree (no peer changes yet) to confirm the suite itself is PATH/environment-clean. If any command fails in an unmodified tree, document this as a known issue at the bottom of the handoff.

- <specific commands for this handoff>

## Report Back

Summarize files changed, verification performed, and any residual risk.
```

## Confirmation Gate

After the answers are collected and the handoff file is written, always confirm with the orchestrator before spawning:

```text
Confirm codex-peer spawn:
- Repo: <repo>
- Handoff: <repo>/.codex/peer-handoffs/<file>.md
- Peer task: <one-line task summary from handoff>
- Start worktree from: <start_ref>
- Merge successful changes to: origin/<merge_branch>
- Wait mode: <spawn_peer or spawn_peer_and_wait>

Proceed?
```

Do not call `spawn_peer` or `spawn_peer_and_wait` until the handoff file exists and the orchestrator confirms.

## Tool Mapping

When confirmed, call codex-peers with separate routing fields. Set `prompt` to the full handoff content, optionally prefixed with the handoff path for traceability:

```json
{
  "repo": "<repo>",
  "prompt": "Handoff file: <repo>/.codex/peer-handoffs/<file>.md\n\n<full handoff content>",
  "start_ref": "<start_ref>",
  "merge_branch": "<merge_branch>"
}
```

Do not rely on the peer reading the handoff from the worktree unless that file is already committed into the selected `start_ref`; always send the handoff content in `prompt`.

Use `target_branch` only for backwards-compatible requests where the start branch and merge branch are intentionally the same and the user did not choose the newer split fields.
