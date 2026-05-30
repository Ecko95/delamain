# codex-mcp-peers-server

Spawn and supervise headless Codex peers across repositories from one orchestrator Codex session.

The package provides:

- an MCP server with tools for spawning, listing, resuming, logging, and killing Codex peers
- detached peer runners backed by `codex exec --json`
- automatic linked worktree isolation for every new peer
- automatic successful-run integration: commit remaining peer edits, merge the selected origin branch, then push back to that branch
- a tmux/Warp-friendly live dashboard
- a one-line tmux status segment

## Install

```bash
npm install
npm run build
```

Register the MCP server with Codex:

```bash
codex mcp add codex-peers -- node /absolute/path/to/codex-mcp-peers-server/dist/index.js server
```

Restart Codex after adding the server. In a Codex session, use the MCP tools:

- `spawn_peer`
- `spawn_peer_and_wait`
- `list_peers`
- `wait_for_peer`
- `peer_status`
- `read_peer_log`
- `send_peer_reply`
- `kill_peer`

To rebuild and re-register the MCP server in one command after pulling updates:

```bash
npm run mcp:restart
```

That command runs `npm install`, builds `dist/`, removes any existing
`codex-peers` MCP registration, adds the rebuilt server, and smoke-tests the
Bun dashboard path when `bun` is installed. Set `CODEX_PEERS_MCP_NAME` if you
registered the server under a different name.

## Dashboard

Run the dashboard in another Warp window or tmux pane:

```bash
node /absolute/path/to/codex-mcp-peers-server/dist/index.js dashboard
```

The dashboard path uses OpenTUI and currently requires Bun. The rest of the
package remains Node-compatible: MCP server, peer CLI commands, tmux status,
logs, and worktree integration still run through Node. Bun is required only for
`codex-peers dashboard`, `codex-peers --d`, `codex-peers -d`, and the v2
dashboard aliases because
`@opentui/core@0.2.4` does not load under Node ESM in this package; Node fails
while importing OpenTUI's bundled `.scm` assets.

Install Bun before running the dashboard:

```bash
curl -fsSL https://bun.sh/install | bash
```

If installed globally or linked:

```bash
codex-peers dashboard
```

Short alias:

```bash
codex-peers --d
```

V2 grid dashboard:

```bash
codex-peers --d2
```

Dashboard keys:

- `tab`/`shift+tab`: focus panes
- `j/k` or arrow keys: select peers
- `Enter` or space: expand/collapse the selected peer details
- `pageup`/`pagedown`: scroll logs
- `r`: refresh
- `x`: open `Kill selected peer?` confirmation
- `Enter`: confirm kill while in kill confirmation
- `Escape`: cancel modes
- `q`: quit

V2 dashboard extras:

- auto-arranged OpenTUI grid that adapts from wide to narrow terminals
- animated spinners for live/active surfaces
- `1`-`7`: collapse or expand Overview, Limits, Telegram, Warnings, Peers, Details, Logs
- `c`: collapse or expand the focused window

Dashboard status notes:

- `done`: peer exited successfully but did not push new commits
- `cleanup`: peer exited successfully, merged/pushed to the target origin branch, and its linked worktree is now only pending cleanup

The dashboard `Peers` pane shows the source project path, such as
`lovable/isomer`, instead of the generated linked worktree directory. Expand a
peer to see the full source path, worktree path, target branch, task, log path,
integration status, latest question, last event, and recent log lines in
bordered OpenTUI panes.

The peer list shows whether a peer is running in the main checkout, a linked
worktree, or an unknown/non-git directory. Active peers that share the same
checkout are marked `shared`; active peers on the same branch across multiple
worktrees are marked `branch`.

## tmux Status Line

Add a compact status indicator:

```tmux
set -g status-right '#(codex-peers tmux-status)'
```

Example:

```text
Codex peers: 4 | working 2 | waiting 1 | cleanup 1 | frozen 0
```

## CLI

Manual spawn:

```bash
codex-peers spawn --repo /path/to/repo --prompt "Review the auth routes and report risks."
```

Choose a Codex model for a peer from the CLI or MCP tool call:

```bash
codex-peers spawn --repo /path/to/repo --prompt "Fix the failing test." --model gpt-5.4
```

The MCP `spawn_peer`, `spawn_peer_and_wait`, and `send_peer_reply` tools also
accept `model`. The selected model is stored on the peer record and shown in
the dashboard Details pane.

The repo must be a Git repository with `origin`. By default, codex-peers bases
the worktree on the origin default branch and pushes successful changes back to
that branch. Use `--start-ref <ref>` to choose where the worktree starts, such
as `origin/main`, `origin/release`, a local branch, `HEAD`, or a commit SHA.
Use `--merge-branch <branch>` to choose the origin branch that receives the
peer changes. If omitted, the merge branch defaults to origin's default branch,
then `main`, then `master`.

Example: start from a local worktree branch and merge to `origin/release`:

```bash
codex-peers spawn \
  --repo /path/to/repo \
  --prompt "Implement the release fix." \
  --start-ref local-experiment \
  --merge-branch release
```

The older `--target-branch <branch>` option is still accepted. When the newer
flags are omitted, it means both `--start-ref origin/<branch>` and
`--merge-branch <branch>`.

Each new peer runs on a fresh `codex-peer/<id>` branch in a linked worktree
under `~/.codex-peers/worktrees/`, not in the checkout passed with `--repo`.

Run with Codex's bypass flag:

```bash
codex-peers spawn --repo /path/to/repo --prompt "Fix the failing test." --yolo
```

`--yolo` is shorthand for Codex's full flag:

```bash
codex-peers spawn \
  --repo /path/to/repo \
  --prompt "Fix the failing test." \
  --dangerously-bypass-approvals-and-sandbox
```

Inspect and control peers:

```bash
codex-peers list
codex-peers status <peer-id>
codex-peers log <peer-id> 120
codex-peers kill <peer-id>
codex-peers resume <peer-id> --prompt "Use option B and continue." --yolo
```

For MCP-driven orchestration, `wait_for_peer` blocks until a peer reaches a terminal status, and `spawn_peer_and_wait` combines spawn plus wait in one tool call. Both accept `timeout_ms`, `poll_interval_ms`, and `log_lines`; timeout returns a structured result without killing the peer.

When a peer exits successfully, the runner integrates that worktree by:

1. committing any remaining uncommitted edits
2. fetching and merging the selected merge origin branch into the peer branch
3. pushing the merged peer branch with `git push origin HEAD:<merge-branch>`

If the merge or push fails, the peer is marked `failed` and its linked worktree
is left in place for inspection.

## State

State and logs live under:

```text
~/.codex-peers/
```

Override with:

```bash
export CODEX_PEERS_HOME=/tmp/codex-peers-test
```

## CODEX_HOME — Codex config and auth directory

Each spawned peer runner sets `CODEX_HOME` explicitly when launching the `codex` subprocess. This ensures codex can always find its auth credentials and `config.toml` regardless of how codex-peers was started (cron, MCP server, or direct CLI).

**Default:** `~/.codex-peers/peer-codex-home`

If `CODEX_HOME` is already set in the environment when codex-peers starts, that value is forwarded unchanged to every peer. If it is not set, codex-peers falls back to `~/.codex-peers/peer-codex-home`.

This directory should contain:

```text
~/.codex-peers/peer-codex-home/
├── auth.json        # OpenAI / ChatGPT credentials written by `codex login`
├── config.toml      # Default model, reasoning effort, trusted project paths, MCP servers
├── sessions/        # Codex thread session files
└── ...              # Other Codex runtime state
```

To set up the peer-codex-home directory, run `codex login` once with `CODEX_HOME` pointing there:

```bash
CODEX_HOME=~/.codex-peers/peer-codex-home codex login
```

To override for a single spawn:

```bash
CODEX_HOME=/custom/path codex-peers spawn --repo /path/to/repo --prompt "..."
```

**Why this exists:** When codex-peers runs as a cron-driven autopilot supervisor or as an MCP server inside Claude Code, the process environment may not carry the `CODEX_HOME` the user configured interactively. Without explicit forwarding, `codex exec` falls back to `~/.codex/` (or an empty default), finds no auth, and the peer dies with SIGTERM immediately after starting.

## Cursor engine (alternative to Codex)

Peers can be driven by either `codex` (default) or `cursor-agent` via the `engine` field on `spawn_peer` / `spawn_peer_and_wait`. Cursor peers shell out to the `cursor-agent` CLI from [Cursor](https://cursor.com), use your Cursor login (so billing flows through your Cursor seat), and support Cursor's full model catalog.

```jsonc
{
  "name": "spawn_peer",
  "arguments": {
    "repo": "/path/to/repo",
    "prompt": "Refactor the auth middleware...",
    "engine": "cursor",
    "model": "sonnet",
    "cursor_options": {
      "cloud": true,
      "approve_mcps": false
    }
  }
}
```

**Model aliases** (cursor engine): `composer-2-fast` (default), `composer-2`, `sonnet`, `sonnet-4.6-thinking`, `opus`, `opus-4.7-max`, `gpt`/`codex`, `grok`, `gemini`, `gemini-flash`. Unknown ids pass through to `cursor-agent` verbatim — run `cursor-agent ls-models` to see the live list.

**`cursor_options`:**
- `cloud` — run the peer on Cursor's cloud infra (`--cloud`). Doesn't consume local CPU; requires only that the worktree be pushed to a branch Cursor can reach.
- `approve_mcps` — auto-approve MCP servers (`--approve-mcps`), e.g. for the `chrome-devtools` browser MCP.
- `force` — pass `--force` (default `true`). Set to `false` to require manual file-edit approvals.

**Setup:**
1. Install Cursor and the `cursor-agent` CLI: <https://cursor.com/install>
2. Sign in once: `cursor-agent login` (uses your Cursor account, including work seats)
3. Override the binary path with `CURSOR_AGENT_BIN` if needed (defaults to `cursor-agent` on `PATH`)

The codex and cursor engines share the same isolated-worktree spawn flow, integration logic, dashboard, and supervisor. Mixing engines per-goal is supported — pick `engine` per `spawn_peer` call.

## Peer Statuses

- `starting`: runner launched
- `working`: Codex process is active
- `waiting`: peer ended with `CODEX_PEERS_STATUS: WAITING`
- `done`: peer exited successfully
- `failed`: peer exited non-zero or could not start
- `frozen`: runner/Codex process vanished or heartbeat is stale
- `killed`: killed by dashboard, CLI, or MCP tool

The dashboard derives one extra display-only status:

- `cleanup`: peer record is `done` and `integrationStatus` is `pushed`, which means the worktree has already been merged and is only waiting to be cleaned up

Peer records include git worktree metadata when the peer was spawned:
`sourceRepo`, `baseRef`, `mergeBranch`, `worktreePath`, `worktreeBranch`,
`gitDir`, `gitCommonDir`, `isLinkedWorktree`, and `integrationStatus`. Use these fields from
`codex-peers status <peer-id>` or MCP `peer_status` to confirm a peer is
running in an independent linked worktree and whether it pushed to
the target origin branch.

Peers are instructed to emit:

```text
CODEX_PEERS_STATUS: WAITING
QUESTION: <one concise question>
```

when they need orchestrator input. `send_peer_reply` resumes the known Codex thread.

## Notes

This does not inject messages into an already-open Codex TUI. It supervises headless Codex peer workers, which gives stronger process control, logs, dashboard status, and kill behavior.
