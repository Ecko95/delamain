# Telegram creds from Notion

The `notify.sh` helper sources `<state-dir>/secrets/telegram.env` which must contain:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

`chmod 600` so only the user can read it.

## Provisioning a new bot

1. In Telegram, message **@BotFather**: `/newbot`.
2. Give it a display name and username.
3. BotFather replies with a token like `123456789:AA-EXAMPLE-BOT-TOKEN-REDACTED`.
4. Send your bot any message (e.g. "hi") to ensure it has a chat with you.
5. Get your chat ID: `curl https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`.

## Storing in Notion (recommended pattern)

Create a Notion page titled `Telegram Credentials (...)` with this exact structure:

```
### bot_token
```javascript
<your token>
```

### chat_id
```javascript
<your chat id>
```
```

The labels (`bot_token`, `chat_id`) and code-block format are what skills like this one match against. Don't change them.

## Fetching from Notion (in a Claude session)

```
mcp__claude_ai_Notion__notion-search query="telegram bot credentials"
mcp__claude_ai_Notion__notion-fetch id=<page-id-from-search>
```

Parse the page text for ` ```javascript ` blocks following `bot_token` and `chat_id` labels. Write to `<state-dir>/secrets/telegram.env` and `chmod 600`.

## Smoke test

```
echo '<b>autopilot smoke</b>' | <state-dir>/notify.sh
```

You should receive a Telegram with the message rendered as bold. Confirm before scheduling cron.

## Rotation

If a token leaks: BotFather → `/revoke` → `/newbot` (or regenerate). Edit the env file. No other state needs to change.
