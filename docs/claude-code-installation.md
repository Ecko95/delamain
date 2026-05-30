# Claude Code Installation Guide

This guide installs `codex-mcp-peers-server` as an MCP server available inside **Claude Code** sessions, and installs the bundled `codex-peers-autopilot` Claude Code skill that lets Claude drive multi-slice Codex peer chains autonomously.

---

## Prerequisites

| Dependency | Install |
|------------|---------|
| Node.js ≥ 18 | `nvm install --lts` |
| Bun (dashboard only) | `curl -fsSL https://bun.sh/install \| bash` |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` |
| [Claude Code CLI](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` |
| `openai-codex` Claude Code plugin | see step 3 |

---

## Step 1 — Clone and build

```bash
git clone https://github.com/<your-org>/codex-mcp-peers-server.git ~/dev/codex-mcp-peers-server
cd ~/dev/codex-mcp-peers-server
npm install
npm run build
```

---

## Step 2 — Authenticate Codex peers

Codex peers run headlessly (from cron or MCP). They need their own `CODEX_HOME` so they can always find credentials, independent of how the process was started.

```bash
CODEX_HOME=~/.codex-peers/peer-codex-home codex login
```

This writes `~/.codex-peers/peer-codex-home/auth.json`. Every peer spawned by `codex-mcp-peers-server` forwards this path automatically.

---

## Step 3 — Register the MCP server with Codex

`codex-peers` tools (`spawn_peer`, `list_peers`, etc.) must be available inside Codex sessions. Register them once:

```bash
codex mcp add codex-peers -- node ~/dev/codex-mcp-peers-server/dist/index.js server
```

Verify:

```bash
codex mcp list   # should show codex-peers
```

After pulling updates, one command rebuilds and re-registers:

```bash
cd ~/dev/codex-mcp-peers-server && npm run mcp:restart
```

---

## Step 4 — Expose the MCP server to Claude Code

Claude Code picks up Codex-registered MCP servers automatically when the `codex@openai-codex` plugin is active. Install the plugin once:

```bash
# Add the openai-codex marketplace
claude settings add-marketplace openai-codex github:openai/codex-plugin-cc

# Enable the Codex plugin
claude plugins install codex@openai-codex
```

Restart Claude Code. Run `/mcp` or `claude mcp list` — you should see:

```
codex:       codex mcp-server                                          ✓ Connected
codex-peers: node /…/codex-mcp-peers-server/dist/index.js server      ✓ Connected
```

> **Alternative (direct registration):** If you prefer not to use the Codex plugin, register the server directly with Claude Code at user scope:
>
> ```bash
> claude mcp add --scope user codex-peers -- node ~/dev/codex-mcp-peers-server/dist/index.js server
> ```

---

## Step 5 — Install the `codex-peers-autopilot` Claude Code skill

The `claude-skill/` directory in this repo is a ready-to-install Claude Code skill. Copy it to your Claude skills directory:

```bash
mkdir -p ~/.claude/skills
cp -r ~/dev/codex-mcp-peers-server/claude-skill ~/.claude/skills/codex-peers-autopilot
```

The skill is now available in every Claude Code session. Invoke it by typing:

```
/codex-peers-autopilot
```

or by asking Claude to "use the codex-peers-autopilot skill".

---

## Step 6 — Trust the project directories Codex will write to

Add your project repos to Codex's trusted paths so peers don't prompt for approval:

```bash
# Example — add once per repo
codex trust /path/to/your/repo
```

Or edit `~/.codex/config.toml` directly:

```toml
[projects."/path/to/your/repo"]
trust_level = "trusted"
```

---

## Step 7 — (Optional) tmux status line

Add a live peer summary to your tmux status bar:

```tmux
set -g status-right '#(node ~/dev/codex-mcp-peers-server/dist/index.js tmux-status)'
```

---

## Verifying the full setup

```bash
# 1. MCP server responds
node ~/dev/codex-mcp-peers-server/dist/index.js server --help

# 2. Claude Code sees the tools
claude mcp list | grep codex-peers

# 3. Skill is importable
ls ~/.claude/skills/codex-peers-autopilot/SKILL.md

# 4. Peer auth works
CODEX_HOME=~/.codex-peers/peer-codex-home codex --version
```

---

## Updating

```bash
cd ~/dev/codex-mcp-peers-server
git pull
npm run mcp:restart        # rebuilds + re-registers with Codex
cp -r claude-skill ~/.claude/skills/codex-peers-autopilot   # update skill
```

---

## What the skill gives you

Once installed, Claude Code can:

- **Bootstrap a new autopilot chain** — scaffold a state directory, Telegram creds, `handoffs.tsv`, and cron jobs for a multi-slice Codex roadmap
- **Attach to a running peer** — wrap an already-spawned Codex peer into an autopilot chain without re-spawning
- **Resume a halted chain** — diagnose `state.halted = true` and guide you through recovery
- **Audit chain state** — inspect the active roadmap, peer statuses, and recent log lines

See `claude-skill/SKILL.md` for the full reference, or `claude-skill/references/architecture.md` for how the supervisor tick loop works.
