#!/usr/bin/env bash
# Telegram sendMessage wrapper for codex-peers-autopilot.
#
# Usage: notify.sh "<text>"  OR  echo "<text>" | notify.sh
# Multi-line input supported. Truncates to 4000 chars (Telegram limit 4096).
# Reads creds from $CODEX_PEERS_AUTOPILOT_DIR/secrets/telegram.env or, as a
# fallback, $HOME/.codex-peers/secrets/telegram.env.

set -euo pipefail

if [[ -n "${CODEX_PEERS_AUTOPILOT_DIR:-}" ]]; then
  CREDS="${CODEX_PEERS_AUTOPILOT_DIR}/secrets/telegram.env"
else
  CREDS="${HOME}/.codex-peers/secrets/telegram.env"
fi

[[ -r "$CREDS" ]] || { echo "missing $CREDS" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CREDS"
: "${TELEGRAM_BOT_TOKEN:?}"
: "${TELEGRAM_CHAT_ID:?}"

if [[ $# -gt 0 ]]; then
  TEXT="$*"
else
  TEXT="$(cat -)"
fi

# Telegram cap is 4096; leave headroom.
TEXT="${TEXT:0:4000}"

curl -sS --max-time 15 \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "parse_mode=HTML" \
  --data-urlencode "disable_web_page_preview=true" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  >/dev/null
