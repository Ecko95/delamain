# codex-mcp-peers-server

Spawn and supervise headless Codex peers across repositories from one orchestrator Codex session.

The package provides:

- an MCP server with tools for spawning, listing, resuming, logging, and killing Codex peers
- detached peer runners backed by `codex exec --json`
- automatic linked worktree isolation for every new peer
- automatic successful-run integration: commit remaining peer edits, merge `origin/main`, then push `HEAD:main`
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

## Dashboard

Run the dashboard in another Warp window or tmux pane:

```bash
node /absolute/path/to/codex-mcp-peers-server/dist/index.js dashboard
```

If installed globally or linked:

```bash
codex-peers dashboard
```

Dashboard keys:

- `k`: kill by row number or peer id prefix
- `r`: refresh
- `q`: quit

The `WT` column shows whether a peer is running in the main checkout, a linked
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
Codex peers: 4 | working 2 | waiting 1 | frozen 1
```

## CLI

Manual spawn:

```bash
codex-peers spawn --repo /path/to/repo --prompt "Review the auth routes and report risks."
```

The repo must be a Git repository with `origin/main`. Each new peer runs on a
fresh `codex-peer/<id>` branch in a linked worktree under
`~/.codex-peers/worktrees/`, not in the checkout passed with `--repo`.

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
2. fetching and merging `origin/main` into the peer branch
3. pushing the merged peer branch with `git push origin HEAD:main`

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

## Peer Statuses

- `starting`: runner launched
- `working`: Codex process is active
- `waiting`: peer ended with `CODEX_PEERS_STATUS: WAITING`
- `done`: peer exited successfully
- `failed`: peer exited non-zero or could not start
- `frozen`: runner/Codex process vanished or heartbeat is stale
- `killed`: killed by dashboard, CLI, or MCP tool

Peer records include git worktree metadata when the peer was spawned:
`sourceRepo`, `worktreePath`, `worktreeBranch`, `gitDir`, `gitCommonDir`,
`isLinkedWorktree`, and `integrationStatus`. Use these fields from
`codex-peers status <peer-id>` or MCP `peer_status` to confirm a peer is
running in an independent linked worktree and whether it pushed to
`origin/main`.

Peers are instructed to emit:

```text
CODEX_PEERS_STATUS: WAITING
QUESTION: <one concise question>
```

when they need orchestrator input. `send_peer_reply` resumes the known Codex thread.

## Notes

This does not inject messages into an already-open Codex TUI. It supervises headless Codex peer workers, which gives stronger process control, logs, dashboard status, and kill behavior.
