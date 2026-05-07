---
name: codex-peers-worktree-routing
description: Prompt the orchestrator before spawning codex-peers with an explicit peer task, worktree start ref, and origin merge branch; use when a user wants codex-peers to start from a chosen branch/ref/worktree and merge to a chosen origin branch.
---

# Codex Peers Worktree Routing

Use this skill before calling the `codex-peers` MCP tools when the peer's start point or merge target matters.

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

## Confirmation Gate

After the answers are collected, always confirm with the orchestrator before spawning:

```text
Confirm codex-peer spawn:
- Repo: <repo>
- Peer task: <one-line task summary>
- Start worktree from: <start_ref>
- Merge successful changes to: origin/<merge_branch>
- Wait mode: <spawn_peer or spawn_peer_and_wait>

Proceed?
```

Do not call `spawn_peer` or `spawn_peer_and_wait` until the orchestrator confirms.

## Tool Mapping

When confirmed, call codex-peers with separate routing fields:

```json
{
  "repo": "<repo>",
  "prompt": "<peer task>",
  "start_ref": "<start_ref>",
  "merge_branch": "<merge_branch>"
}
```

Use `target_branch` only for backwards-compatible requests where the start branch and merge branch are intentionally the same and the user did not choose the newer split fields.
