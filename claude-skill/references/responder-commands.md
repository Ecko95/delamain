# Telegram responder commands

The responder polls `getUpdates` once per minute (1-min cron) with a 10-second long-poll, so replies usually arrive in well under a minute. Every command is authenticated by `chat_id`: messages from any chat other than `TELEGRAM_CHAT_ID` are silently ignored and logged.

## Built-in commands

| Command | Purpose |
|---|---|
| `/help` | List commands. |
| `/status` | Current slice + index/total, peer status (`codex-peers status`), branch, halt state, history outcome counts, last main SHA. |
| `/halt [reason]` | Set `state.halted = true` with the supplied reason (defaults to "user via Telegram"). |
| `/resume` | Set `state.halted = false`, `halted_reason = null`. |
| `/log [N]` | Last N supervisor log lines for today. Default 30, max 200. |
| `/peers` | `codex-peers list` filtered to this roadmap's `repo_path`. |
| `/kill <peer-id>` | `codex-peers kill <peer-id>`. |
| `/cleanup <peer-id>` | `codex-peers cleanup <peer-id>`. Removes the worktree. |

`/start` is treated as `/help` so the user gets onboarding when they first open the bot chat.

## How dispatch works

1. `getUpdates` returns pending messages with `update_id`.
2. The responder iterates updates; for each:
   - Validate `chat_id` matches `TELEGRAM_CHAT_ID`.
   - Strip a `@botname` suffix if present (e.g. `/status@MyBot`).
   - Match the command verbatim against the table above.
   - Run the handler.
   - Reply via `sendMessage`.
3. Persist the highest `update_id + 1` to `<state-dir>/.responder-offset` so the next tick doesn't re-process.

Non-command messages (anything not starting with `/`) are logged and silently ignored.

## Adding your own command

In `scripts/responder.py` find the `dispatch()` function. Add a new branch:

```python
if cmd == "/your-command":
    return your_handler(arg, config)
```

Define `your_handler` near the existing command functions. Keep replies under ~3500 chars (Telegram cap is 4096; we leave headroom for HTML tags). Use `<pre>...</pre>` for code/log output, `<code>...</code>` for short identifiers, `<b>...</b>` for headers.

If your handler runs a subprocess that takes more than a few seconds, beware: the responder is a one-shot cron tick with a 30-second total budget by convention. For longer operations, kick off `codex-peers` work and reply with the peer ID immediately.

## State writes

`/halt` and `/resume` mutate `state.json` directly. They do NOT take the supervisor's `flock` because the responder is a separate process and the writes are short. The supervisor's atomic `tmp + replace` plus the responder's similar pattern keep races to "last writer wins" — acceptable since concurrent halt/resume is unlikely.

## Security

- Only the configured chat ID can issue commands.
- Treat the bot token as a secret; rotation is documented in `references/notion-creds-lookup.md`.
- Anyone with the bot token can hit `getUpdates` and read messages, so don't share tokens.
- `/kill` and `/cleanup` are destructive; the responder doesn't ask for confirmation. If you want a confirmation step, modify the handler to set a "pending action" key in state and require `/confirm` from the same chat.
