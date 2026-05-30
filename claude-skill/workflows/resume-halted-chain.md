# Workflow: Resume a halted chain

<required_reading>
1. references/halt-recovery.md
2. references/state-schema.md
3. references/auto-review-policy.md (if halt was a verification or forbidden-touch failure)
</required_reading>

<process>
## Step 1: Locate the state dir

Ask the user for the roadmap name, or list existing autopilots:

```bash
ls -la ~/.codex-peers/ | grep -v worktrees
```

Each subdir with a `state.json` is an autopilot. Pick the relevant one.

## Step 2: Inspect halt state

```bash
STATE=$STATE_DIR/state.json
jq '{halted, halted_reason, current_slice_id, current_peer_id, current_merge_branch}' "$STATE"
```

Read `halted_reason` carefully — it tells you what gate failed.

## Step 3: Pull recent supervisor log

```bash
tail -80 "$STATE_DIR/logs/supervisor-$(date -u +%Y-%m-%d).log"
```

Look for the failure message and the surrounding context.

## Step 4: Inspect the peer (if relevant)

```bash
PEER_ID=$(jq -r '.current_peer_id' "$STATE")
codex-peers status "$PEER_ID"
codex-peers log "$PEER_ID" 100
```

If the halt was an auto-review failure, the peer's worktree is still in place at the path shown by `status`. cd in and inspect the diff:

```bash
WT=$(codex-peers status "$PEER_ID" | jq -r '.worktreePath')
cd "$WT"
git diff --stat origin/main..HEAD
```

## Step 5: Diagnose with the user

Walk through `references/halt-recovery.md` for the halt reason category. Identify the root cause and the fix.

Use AskUserQuestion to confirm the recovery path:

1. **Edit the worktree, fix the failure, manually merge the PR, mark auto-merged in state, clear halt** — most surgical when fix is small.
2. **Resume the peer with a follow-up prompt** — when the peer should fix its own work.
3. **Re-spawn the slice** — when the work needs to start over.
4. **Skip the slice** — when the slice is no longer needed.
5. **Halt indefinitely** — user wants to stop the chain entirely; skill exits without changing state.

## Step 6: Apply the recovery

For each path, follow the steps in `references/halt-recovery.md`.

## Step 7: Clear halt

```bash
jq '.halted = false | .halted_reason = null' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
```

## Step 8: Trigger a tick to verify

```bash
CODEX_PEERS_AUTOPILOT_DIR=$STATE_DIR /usr/bin/python3 ~/.claude/skills/codex-peers-autopilot/scripts/supervisor.py
tail -20 "$STATE_DIR/logs/supervisor-$(date -u +%Y-%m-%d).log"
```

Confirm:
- The next tick does NOT immediately re-halt.
- The peer's status is what you expect.
- No duplicate notifications fired (check `notified_events` is consistent).

## Step 9: Report to the user

Send a Telegram acknowledging the resume:

```bash
echo '<b>🔁 chain resumed</b>\nReason resolved: '"$OLD_REASON"'\nCurrent slice: '"$CURRENT_SLICE"'.' | "$STATE_DIR/notify.sh"
```

Tell the user what was fixed and what to expect next (peer continues, or next slice spawns on next tick).
</process>

<success_criteria>
- `state.halted` is `false`.
- The next manual supervisor tick logs `tick complete` without re-halting.
- Telegram resume notification delivered.
- The user understands what was fixed and what should happen next.
</success_criteria>
