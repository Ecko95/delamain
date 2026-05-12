# Workflow: Attach to an already-running peer

<required_reading>
1. references/architecture.md
2. references/state-schema.md
</required_reading>

Use when the user has already spawned a `codex-peers` peer manually (or via MCP) and wants the autopilot to pick up from there.

<process>
## Step 1: Gather inputs

Ask via AskUserQuestion:

1. **Peer ID** — the in-flight peer to attach as the chain's current slice (e.g. `a9f9a0a3`).
2. **Roadmap name** — slug for the state dir.
3. **Slice list** — same as bootstrap. The attached peer becomes slice 0; subsequent rows in `handoffs.tsv` are spawned automatically once slice 0 merges.
4. Other inputs (forbidden paths, Telegram creds, verification suite) — same as bootstrap.

## Step 2: Run bootstrap steps 2–10

Identical to `workflows/bootstrap-new-roadmap.md` steps 2 through 10: scaffold the dir, provision creds, copy assets, write config.json, write handoffs.tsv, smoke-test Telegram, customize peer-prompt template if needed, schedule cron.

**Important difference at Step 9 (state.json):** instead of `current_slice_index: -1`, attach to the running peer.

```bash
PEER_ID=<existing-peer-id>
PEER_JSON=$(codex-peers status "$PEER_ID")
PEER_MERGE_BRANCH=$(jq -r '.mergeBranch' <<<"$PEER_JSON")

# Validate: peer's mergeBranch must match handoffs.tsv slice 0.
# If they differ, halt and ask the user before continuing.

DEFAULT_BRANCH=$(jq -r '.default_branch // "main"' "$STATE_DIR/config.json")
REPO_PATH=$(jq -r '.repo_path' "$STATE_DIR/config.json")
git -C "$REPO_PATH" fetch origin "$DEFAULT_BRANCH" --quiet
HEAD_SHA=$(git -C "$REPO_PATH" rev-parse "origin/$DEFAULT_BRANCH")

# Pull slice 0 from handoffs.tsv (first non-comment row).
read SLICE0_ID SLICE0_TITLE SLICE0_BRANCH SLICE0_MODEL SLICE0_YOLO < <(awk -F'\t' '!/^#/ && NF >= 5 {print; exit}' "$STATE_DIR/handoffs.tsv")

cat > "$STATE_DIR/state.json" <<EOF
{
  "schema_version": 1,
  "halted": false,
  "halted_reason": null,
  "current_slice_id": "$SLICE0_ID",
  "current_slice_index": 0,
  "current_peer_id": "$PEER_ID",
  "current_merge_branch": "$PEER_MERGE_BRANCH",
  "current_pushed_sha": "",
  "last_origin_main_sha": "$HEAD_SHA",
  "notified_events": ["spawn:$PEER_ID"],
  "history": [
    {"slice_id": "$SLICE0_ID", "peer_id": "$PEER_ID", "merge_branch": "$PEER_MERGE_BRANCH", "spawned_at": "$(date -u +%FT%TZ)", "outcome": null}
  ]
}
EOF
```

The `spawn:<peer_id>` event is pre-marked so the autopilot doesn't re-notify on first tick.

## Step 3: Skip step 11 (spawn)

Don't spawn anything — the peer is already running.

## Step 4: First tick

Run the supervisor once manually to confirm it picks up the peer correctly:

```bash
CODEX_PEERS_AUTOPILOT_DIR=$STATE_DIR /usr/bin/python3 $HOME/.claude/skills/codex-peers-autopilot/scripts/supervisor.py
tail -20 "$STATE_DIR/logs/supervisor-$(date -u +%Y-%m-%d).log"
```

Expected output: `tick: slice=<id> peer=<peer> merge_branch=<branch>` followed by `peer status=working ...` and `tick complete`. No notifications fire because the peer is still working and the spawn event was pre-marked.

## Step 5: Send a "now under autopilot" Telegram

```bash
echo '<b>🤖 autopilot attached</b>\nPeer '"$PEER_ID"' for slice '"$SLICE0_ID"' is now supervised.' | "$STATE_DIR/notify.sh"
```

## Step 6: Hand off

Same as bootstrap step 12.
</process>

<success_criteria>
- State dir scaffolded, config.json valid, handoffs.tsv valid, cron scheduled.
- `state.json.current_peer_id` matches the user-provided peer.
- `state.json.current_merge_branch` matches the peer's `mergeBranch` from `codex-peers status`.
- First manual supervisor tick exits cleanly with no Telegram notifications.
- The attach Telegram was delivered.
</success_criteria>
