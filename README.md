# codex-mcp-peers-server

Spawn and supervise headless Codex peers across repositories from one orchestrator Codex session.

The package provides:

- an MCP server with tools for spawning, listing, resuming, logging, and killing Codex peers
- detached peer runners backed by `codex exec --json`
- automatic linked worktree isolation for every new peer
- automatic successful-run integration: commit remaining peer edits, merge the origin default branch, then push back to that branch
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
`codex-peers dashboard`, `codex-peers --d`, and `codex-peers -d` because
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
the worktree on the origin default branch. Pass `--target-branch <branch>` to
force a specific origin branch. Each new peer runs on a fresh `codex-peer/<id>`
branch in a linked worktree under `~/.codex-peers/worktrees/`, not in the
checkout passed with `--repo`.

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
2. fetching and merging the target origin branch into the peer branch
3. pushing the merged peer branch with `git push origin HEAD:<target-branch>`

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

The dashboard derives one extra display-only status:

- `cleanup`: peer record is `done` and `integrationStatus` is `pushed`, which means the worktree has already been merged and is only waiting to be cleaned up

Peer records include git worktree metadata when the peer was spawned:
`sourceRepo`, `worktreePath`, `worktreeBranch`, `gitDir`, `gitCommonDir`,
`isLinkedWorktree`, and `integrationStatus`. Use these fields from
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
