# Merge detection

Detecting "did our PR land?" is harder than it looks because GitHub's three merge strategies each affect git state differently. The autopilot uses a three-step cascade.

## The three strategies

| Strategy | What lands on `<default_branch>` | Original `<pushed_sha>` |
|---|---|---|
| `merge` | A new merge commit with two parents: previous `<default>` HEAD and `<pushed_sha>`. | Preserved as a parent. |
| `rebase` | Each commit on the PR branch is replayed onto `<default>`, getting **new SHAs**. | Discarded. |
| `squash` | A single new commit on `<default>` containing all PR changes. | Discarded. |

`gh pr merge --delete-branch` also removes `origin/<merge_branch>` after the merge.

## The cascade

For each tick where `origin/<default>` advanced:

### 1. Direct ref ancestry

```
git fetch origin <merge_branch>          # may fail silently if branch was deleted
git merge-base --is-ancestor origin/<merge_branch> origin/<default_branch>
```

Works for `merge` strategy if the branch wasn't deleted. Cheap, exact. If success, we're merged.

### 2. Pushed-SHA ancestry

```
git merge-base --is-ancestor <state.current_pushed_sha> origin/<default_branch>
```

Works for `merge` strategy even if the branch was deleted (the pushed SHA is now in the history). Doesn't work for `rebase` or `squash`.

### 3. Patch-id cherry

```
git cherry origin/<default_branch> <state.current_pushed_sha>
```

`git cherry` computes a patch-id (a hash of the diff, ignoring SHAs and timestamps) for each commit on the right side and looks for an equivalent patch on the left. Output:

```
+ <sha>     # not equivalent to anything in <default_branch>
- <sha>     # equivalent to a commit already in <default_branch>
```

If the first non-blank output line starts with `-`, the patch is in `<default_branch>`. This catches `rebase` and `squash` merges.

## Why we capture `current_pushed_sha`

When a peer transitions to `done + pushed`, the supervisor reads `git -C <worktreePath> rev-parse HEAD` and stores it in `state.current_pushed_sha` BEFORE the auto-merge fires. This SHA persists across deletions of the remote branch and is the input to both fallback checks.

## Edge cases handled

- **`--delete-branch`**: `git fetch origin <merge_branch>` fails; ancestry check #1 fails. Fallbacks #2/#3 still work.
- **Force-push to merge branch**: pushed SHA may no longer be on the branch but is still on the peer's worktree, so #2/#3 still work.
- **Rebase merge**: #1 fails (branch may exist locally but its tip isn't an ancestor of `<default>`). #3 succeeds.
- **Squash merge**: same as rebase — #3 succeeds.
- **Peer worktree cleaned up**: `current_pushed_sha` was already saved before cleanup, so #2/#3 still work.

## What "not in main yet" means

The supervisor logs `"main advanced but <branch> is not in main; treating as unrelated commit"` when **all three checks fail**. This is normal if someone pushed a hotfix to main while the autopilot's chain was running. The supervisor advances `last_origin_main_sha` and continues watching.

If you see this message right after you merged the PR, something is genuinely wrong:
1. Check `current_pushed_sha` is set correctly in `state.json`.
2. Verify the peer worktree still exists (or its SHA is in your reflog).
3. Try `git cherry origin/<default> <pushed_sha>` manually — what does it return?
