# Halt recovery

When the autopilot halts, `state.halted = true` and `state.halted_reason` describes what happened. Every halt sends one Telegram. The chain stays frozen until the user manually clears `halted = false`.

## Halt reasons and recovery

### `<slice>: peer touched forbidden paths: [...]`

The peer's diff modified a file listed in `config.forbidden_paths` and the slice isn't in `forbidden_exception_slices`.

**Diagnose:** open the peer worktree (`peer.worktreePath`) and inspect the diff against `origin/<default_branch>`.

**Recovery options:**
1. **Tighten the peer prompt** so future runs respect the boundary, then re-spawn the slice (kill the current peer, set `current_peer_id = ""`, clear halt, manually spawn).
2. **Add the slice to `forbidden_exception_slices`** if the touch was actually intended.
3. **Edit the worktree** to revert the forbidden touches manually, then `codex-peers resume <peer_id>` to re-push.
4. **Skip the slice** — advance `current_slice_index`, fix `current_slice_id` and `current_merge_branch` to point at the next row in handoffs.tsv, clear `current_peer_id`, clear halt.

### `<slice>: verification failed at <label>`

A check from `config.verification_commands` exited non-zero. The Telegram shows the last ~1500 chars of the first failing command.

**Diagnose:** cd into `peer.worktreePath`; rerun the failing command; read the full error.

**Recovery options:**
1. **Edit the worktree** to fix the issue; rerun the verification commands manually; once green, manually `gh pr create` + `gh pr merge` and delete the failing slice's history entry's `outcome`. Clear halt — next tick will detect main advance and spawn the next slice. (Skip the auto-review re-run by marking `auto-merged:<peer_id>` in `state.notified_events`.)
2. **Resume the peer** with a follow-up prompt asking it to fix specifically the failure: `codex-peers resume <peer_id> --prompt "..."`.
3. **Re-spawn the slice** if the fix is large.

### `<slice> peer <peer_id> merge-failed`

The codex-peers runner couldn't merge `origin/<merge_branch>` into the peer branch and push. Common causes: divergent state, branch protection, network, auth.

**Diagnose:** `codex-peers status <peer_id>` shows full integration error. `codex-peers log <peer_id> 200` shows runner output.

**Recovery:**
1. cd into the peer worktree.
2. Manually `git fetch origin && git merge origin/<merge_branch>` and resolve conflicts.
3. `git push origin HEAD:<merge_branch>`.
4. Mark the history entry `outcome: pushed`, append `auto-merged:<peer_id>` to `notified_events`, clear halt — auto-review will fire next tick.

### `<slice> peer <peer_id> failed | frozen | killed`

The peer's process exited badly or was killed.

**Diagnose:** `codex-peers log <peer_id> 200`.

**Recovery:** almost always re-spawn. Set `current_peer_id = ""`, clear halt, manually spawn (or run the bootstrap workflow's spawn step targeting the same slice).

### `preflight failed for <slice>`

The hard preflight gate (origin/start_ref vs origin/merge_branch divergence, large blobs) blocked the spawn.

**Diagnose:** check `codex-peers preflight --repo <repo> --start-ref origin/<default> --merge-branch <slice_branch>` directly.

**Recovery:** sync or sanitize the start branch, or change the merge target. Then clear halt — next tick re-attempts the spawn.

### `gh pr create failed | gh pr merge failed`

Almost always permissions, branch protection, or network.

**Diagnose:** read the error tail in the Telegram. Try `gh auth status` and the failed command manually.

**Recovery:** fix the permission/protection; clear halt. The supervisor will retry on next tick.

## How to clear halt

```
jq '.halted = false | .halted_reason = null' <state-dir>/state.json | sponge <state-dir>/state.json
```

(Or just edit the file.) Next cron tick resumes from `current_*` fields.

## When NOT to clear halt

- Tests are still failing.
- You haven't actually fixed the root cause.
- The peer worktree was destroyed before you investigated.
- You don't know why the chain halted.

The whole point of halt-on-failure is to keep things frozen until a human verifies recovery is safe. Don't bypass.
