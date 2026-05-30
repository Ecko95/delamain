# Workflow: Bootstrap a new roadmap

<required_reading>
Read these references before starting:
1. references/architecture.md — what you're installing
2. references/config-schema.md — what config.json must contain
3. references/state-schema.md — what state.json must contain
4. references/notion-creds-lookup.md — how to fetch Telegram creds
</required_reading>

<process>
## Step 1: Gather inputs from the user

Ask via AskUserQuestion (single message, batched):

1. **Repo path** — absolute path to the target git repo (must have `origin`).
2. **Roadmap name** — short slug used for the state dir, e.g. `hub-roadmap`. State will live at `~/.codex-peers/<roadmap-name>/`.
3. **Source of slice list** — paste a list inline, point at a plan file (the workflow will read and propose a TSV), or hand-write TSV directly.
4. **Forbidden paths** — comma-separated list of files/dirs the autopilot should refuse to let any peer touch (with optional exception slice IDs).
5. **Telegram creds source** — Notion page (skill fetches it), an existing `~/.codex-peers/secrets/telegram.env` (reuse), or paste inline.

For repos with non-standard tooling, also ask whether the default verification suite (`npm run lint`, `tsc --noEmit`, `npm test -- --run`, `npm run build`) is right.

## Step 2: Scaffold the state directory

```bash
ROADMAP=<roadmap-name>
STATE_DIR="$HOME/.codex-peers/$ROADMAP"
mkdir -p "$STATE_DIR/secrets" "$STATE_DIR/logs"
chmod 700 "$STATE_DIR/secrets"
```

## Step 3: Provision Telegram creds

If user chose Notion source: run `mcp__claude_ai_Notion__notion-search` then `mcp__claude_ai_Notion__notion-fetch`, extract `bot_token` and `chat_id` from the `javascript` code blocks, write to `$STATE_DIR/secrets/telegram.env`.

If user chose existing creds: copy or symlink `~/.codex-peers/secrets/telegram.env` to `$STATE_DIR/secrets/telegram.env` (or leave it — `notify.sh` falls back to the home-default if `$STATE_DIR/secrets/telegram.env` is absent).

If user pasted inline: write the env file directly.

```bash
chmod 600 "$STATE_DIR/secrets/telegram.env"
```

## Step 4: Copy skill assets into the state dir

```bash
SKILL_DIR="$HOME/.claude/skills/codex-peers-autopilot"
cp "$SKILL_DIR/scripts/notify.sh" "$STATE_DIR/notify.sh"
cp "$SKILL_DIR/scripts/responder.py" "$STATE_DIR/responder.py"
cp "$SKILL_DIR/templates/peer-prompt.template" "$STATE_DIR/peer-prompt.template"
chmod +x "$STATE_DIR/notify.sh" "$STATE_DIR/responder.py"
```

The supervisor itself stays in the skill dir (`$SKILL_DIR/scripts/supervisor.py`) — cron invokes it directly without copying.

(Optional but recommended: the responder is also installed in the state dir so it can be invoked from cron with the same `CODEX_PEERS_AUTOPILOT_DIR` env var.)

## Step 5: Write config.json

Start from `templates/config.json.example`. Fill in:
- `repo_path` (absolute)
- `default_branch` (default `main`)
- `path_prefix` — find node bin dir with `dirname $(which node)` and prepend `/usr/bin`, `/usr/local/bin`
- `forbidden_paths` and `forbidden_exception_slices` from user input
- `verification_commands` from user input or template defaults
- `pr_title_prefix` and `peer_name_prefix` (defaults are fine)

Write to `$STATE_DIR/config.json`. Validate parses with `python3 -c "import json; json.load(open('$STATE_DIR/config.json'))"`.

## Step 6: Write handoffs.tsv

If user pasted/provided a slice list, write it to `$STATE_DIR/handoffs.tsv` matching the template format:

```
slice_id<TAB>title<TAB>merge_branch<TAB>model<TAB>yolo
```

Validate: `awk -F'\t' '!/^#/ && NF != 5 {print "bad row:", $0; exit 1}' "$STATE_DIR/handoffs.tsv" && echo OK`.

## Step 7: Smoke-test Telegram

```bash
echo '<b>autopilot smoke</b>\nbootstrap from skill ok' | "$STATE_DIR/notify.sh"
```

If the user does not receive the Telegram, debug before continuing.

## Step 8: Customize the peer-prompt template (optional)

If the roadmap has an authoritative plan file (e.g. `~/.claude/plans/<plan>.md`), edit `$STATE_DIR/peer-prompt.template` to point peers at it (replace the "Authoritative roadmap reference" section).

## Step 9: Initialize state.json

```bash
DEFAULT_BRANCH=$(jq -r '.default_branch // "main"' "$STATE_DIR/config.json")
REPO_PATH=$(jq -r '.repo_path' "$STATE_DIR/config.json")
git -C "$REPO_PATH" fetch origin "$DEFAULT_BRANCH" --quiet
HEAD_SHA=$(git -C "$REPO_PATH" rev-parse "origin/$DEFAULT_BRANCH")

cat > "$STATE_DIR/state.json" <<EOF
{
  "schema_version": 1,
  "halted": false,
  "halted_reason": null,
  "current_slice_id": "",
  "current_slice_index": -1,
  "current_peer_id": "",
  "current_merge_branch": "",
  "current_pushed_sha": "",
  "last_origin_main_sha": "$HEAD_SHA",
  "notified_events": [],
  "history": []
}
EOF
```

`current_slice_index = -1` means "nothing started yet"; the spawn step below seeds slice 0.

## Step 10: Schedule cron

Append to crontab (do not clobber existing entries). Two cron entries: the supervisor (every 5 min) and the responder (every minute).

```bash
( crontab -l 2>/dev/null; cat <<EOF

# codex-peers-autopilot: $ROADMAP supervisor — every 5 min
*/5 * * * * CODEX_PEERS_AUTOPILOT_DIR=$STATE_DIR /usr/bin/python3 $HOME/.claude/skills/codex-peers-autopilot/scripts/supervisor.py >> $STATE_DIR/logs/cron.log 2>&1

# codex-peers-autopilot: $ROADMAP responder — every minute (Telegram replies)
* * * * * CODEX_PEERS_AUTOPILOT_DIR=$STATE_DIR /usr/bin/python3 $STATE_DIR/responder.py >> $STATE_DIR/logs/cron-responder.log 2>&1
EOF
) | crontab -
```

Verify: `crontab -l | grep $ROADMAP`.

The user can reply to the bot chat with `/help` to discover commands; the responder picks it up within ~1 min.

## Step 11: Spawn slice 0

Read first slice from handoffs.tsv. Pre-create the merge branch on origin:

```bash
git -C "$REPO_PATH" push origin "origin/$DEFAULT_BRANCH:refs/heads/<slice0_merge_branch>"
```

Run preflight:

```bash
codex-peers preflight --repo "$REPO_PATH" --start-ref "origin/$DEFAULT_BRANCH" --merge-branch <slice0_merge_branch>
```

If preflight passes, build the peer prompt and spawn:

```bash
PROMPT=$(sed -e "s|{{SLICE_ID}}|<slice0_id>|g" -e "s|{{SLICE_TITLE}}|<slice0_title>|g" -e "s|{{MERGE_BRANCH}}|<slice0_merge_branch>|g" "$STATE_DIR/peer-prompt.template")
codex-peers spawn \
  --repo "$REPO_PATH" \
  --start-ref "origin/$DEFAULT_BRANCH" \
  --merge-branch <slice0_merge_branch> \
  --model <slice0_model> \
  --name autopilot-<slice0_id_lower> \
  ${SLICE0_YOLO:+--yolo} \
  --prompt "$PROMPT"
```

Capture the peer JSON and update state.json: set `current_slice_id`, `current_slice_index = 0`, `current_peer_id`, `current_merge_branch`. Append to `history`. Mark `spawn:<peer_id>` in `notified_events`. Send a Telegram via `notify.sh`.

## Step 12: Hand off

Tell the user:
- Peer ID and where to follow logs (`codex-peers status <id>` and `<state-dir>/logs/supervisor-*.log`).
- Cron is firing every 5 min; they don't have to do anything else.
- Halt expectations: if anything goes wrong, they'll get a Telegram and the chain freezes until they clear `halted` in `state.json`.
</process>

<success_criteria>
- `<state-dir>/{config.json,handoffs.tsv,state.json,peer-prompt.template,notify.sh,secrets/telegram.env}` all exist and validate.
- Smoke-test Telegram was delivered.
- Cron entry is present and references the correct `CODEX_PEERS_AUTOPILOT_DIR`.
- Slice 0 peer is `working` per `codex-peers status`.
- User received the spawn Telegram.
- Running `python3 ~/.claude/skills/codex-peers-autopilot/scripts/supervisor.py` manually with the env var set produces a clean `tick complete` log entry with no errors.
</success_criteria>
