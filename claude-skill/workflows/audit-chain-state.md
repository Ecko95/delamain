# Workflow: Audit current chain state

<required_reading>
1. references/state-schema.md
</required_reading>

Use when the user asks "what's the autopilot doing?" / "is it still running?" / "show me the chain status".

<process>
## Step 1: Identify the autopilot

If the user names a roadmap, use it. Otherwise list:

```bash
ls -la ~/.codex-peers/ | grep -v worktrees
for d in ~/.codex-peers/*/; do
  if [[ -f "$d/state.json" ]]; then
    echo "=== $d ==="
    jq '{current_slice_id, current_peer_id, halted, halted_reason}' "$d/state.json"
  fi
done
```

## Step 2: Snapshot state

```bash
STATE=$STATE_DIR/state.json
jq '.' "$STATE"
```

## Step 3: Summarize for the user

Build a single message covering:

- **Active slice:** `current_slice_id` (`current_slice_index`/total from handoffs.tsv).
- **Active peer:** `current_peer_id` and its current `codex-peers status` (working / waiting / done / etc.) and `lastEvent`.
- **Halted?:** if yes, show `halted_reason` and point to the resume workflow.
- **History:** count of merged slices, count of pushed-but-pending slices, count of failures.
- **Last log lines:** `tail -20 $STATE_DIR/logs/supervisor-$(date -u +%Y-%m-%d).log`.
- **Open PRs:** `gh pr list --repo $(jq -r .repo_path "$STATE_DIR/config.json" | xargs -I {} git -C {} remote get-url origin) --state open --json number,title,headRefName,url` (if relevant).
- **Cron health:** `tail -20 $STATE_DIR/logs/cron.log` to confirm cron is firing.

## Step 4: Highlight anomalies

Flag any of:
- Peer `frozen` (heartbeat stale) — likely needs `codex-peers kill` + recovery.
- `last_origin_main_sha` older than the actual `origin/<default>` HEAD — supervisor hasn't detected a recent merge; investigate via merge-detection cascade.
- `notified_events` containing `merged:<peer>` but `current_slice_id` still on the same slice — supervisor advanced state but spawn_next failed silently.
- Multiple peers in `codex-peers list` with `working` status against the same repo — possible leftover from manual spawns; no harm but worth noting.

## Step 5: Suggest next action (if any)

Based on the snapshot:

- If healthy and working → nothing to do; chain is progressing.
- If halted → route to `workflows/resume-halted-chain.md`.
- If chain is complete → suggest cleanup of the state dir (after user confirms).
- If anomaly detected → suggest specific recovery from `references/halt-recovery.md`.
</process>

<success_criteria>
- The user has a clear picture of what slice is active, what peer is in flight, and what the chain has accomplished.
- Any anomaly is surfaced with a recommended next step.
- No state changes were made by this workflow (read-only).
</success_criteria>
