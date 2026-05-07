---
quick_id: 260507-wc6
slug: i-need-the-option-to-tell-codex-peers-to
status: complete
completed: "2026-05-07T23:23:38+02:00"
---

# Quick Task 260507-wc6 Summary

Implemented configurable codex-peers worktree routing.

## Completed

- Added `start_ref` / `startRef` and `merge_branch` / `mergeBranch` support to MCP spawn tools.
- Added CLI flags `--start-ref` and `--merge-branch`.
- Preserved legacy `target_branch` / `--target-branch` behavior as "start from and merge to this origin branch" when newer fields are omitted.
- Stored `mergeBranch` in peer records and displayed it in dashboard details.
- Added a project-local skill at `.codex/skills/codex-peers-worktree-routing/SKILL.md` that asks for peer task, start ref, merge branch, and final confirmation before spawning.
- Updated README usage docs.

## Verification

- `npm test` passed: 20 tests.
