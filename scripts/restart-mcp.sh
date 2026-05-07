#!/usr/bin/env bash
set -euo pipefail

MCP_NAME="${CODEX_PEERS_MCP_NAME:-codex-peers}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENTRY="$REPO_ROOT/dist/index.js"

cd "$REPO_ROOT"

echo "[codex-peers] installing dependencies"
npm install

echo "[codex-peers] building"
npm run build

echo "[codex-peers] re-registering Codex MCP server: $MCP_NAME"
if command -v codex >/dev/null 2>&1; then
  codex mcp remove "$MCP_NAME" >/dev/null 2>&1 || true
  codex mcp add "$MCP_NAME" -- node "$ENTRY" server
else
  echo "[codex-peers] codex command not found; install Codex CLI before registering MCP" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  echo "[codex-peers] smoke testing Bun dashboard runtime"
  CODEX_PEERS_DASHBOARD_SMOKE=1 node "$ENTRY" --d >/dev/null
else
  echo "[codex-peers] bun not found; MCP server is registered, dashboard will need Bun installed"
fi

echo "[codex-peers] done"
echo "[codex-peers] restart Codex sessions so they connect to the refreshed MCP server"
