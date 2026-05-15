# GSD Daemon Research

## 1. Overview

`gsd-build/daemon` is a MIT-licensed Go daemon for user machines. It is a single `gsd-cloud` binary that pairs a local machine to GSD Cloud, keeps a persistent outbound relay connection, and supervises local agent execution. The intended deployment is a user-level service on macOS or Linux, started by `launchd` or `systemd --user`, not a container or a public TCP server.

Language and stack:

- Go 1.26
- `cobra` for the CLI surface
- `coder/websocket` for the relay transport
- `log/slog` plus `lumberjack` for structured logging and rotation
- `protocol-go` for the relay message schema
- a bundled `pi` extension archive for the agent runtime

The high-level topology is:

- local user runs `gsd-cloud login` once to pair
- `gsd-cloud start` launches the daemon as a background service
- the daemon dials `relay.gsd.build` outbound over WebSocket
- local status is exposed only on a Unix socket
- task execution happens in child processes managed by session actors

Short code pointer:

```go
sockSrv := sockapi.NewServer(d.sockPath, d)
go sockSrv.ListenAndServe(ctx)
```

## 2. Process Model

This is a single long-lived daemon process with a small supervisor tree around it.

- `main.go` just calls `cmd.Execute()`
- `cmd/start.go` builds `internal/loop.Daemon` and runs it
- the OS service manager is external supervision, not an in-process supervisor binary
- inside the daemon, `loop.Daemon` starts goroutines for:
  - the local Unix-socket status API
  - relay heartbeats
  - token refresh checks
  - stale touched-file cleanup
- session execution is actor-based: `internal/session.Manager` keeps one actor per session ID
- each actor may spawn per-task `pi` subprocesses and optional warm workers

The important shape is "one daemon, many child workers". It is not a worker pool daemon in the RabbitMQ sense, and it is not an MCP-style request/response server.

Code pointers:

- `cmd/start.go`
- `internal/loop/daemon.go`
- `internal/session/manager.go`
- `internal/pi/worker.go`
- `internal/agentterminal/control_server.go`

## 3. API Surface

There are three distinct surfaces.

### Local status API

The daemon listens on a Unix domain socket and serves HTTP endpoints:

- `GET /health`
- `GET /status`
- `GET /sessions`
- `GET /workers`

These are read-only and return JSON. There is no public TCP listener for this surface.

### Cloud pairing API

The CLI talks to the GSD Cloud web app over HTTPS:

- `POST /api/daemon/pair`
- `POST /api/daemon/refresh-token`

Those endpoints create and refresh the machine token used by the daemon.

### Relay protocol

The daemon uses a persistent WebSocket connection to the relay, sending and receiving JSON envelopes. The messages cover:

- `Hello` / `Welcome`
- task lifecycle and stop control
- terminal open/input/resize/close
- filesystem and skills access
- permission and question responses
- preview open/close, HTTP proxying, and WebSocket bridging
- heartbeat and local-server detection
- agent-terminal attach/snapshot flows

This is not gRPC and not MCP. It is an app-specific JSON message protocol carried over WebSocket.

Short code pointer:

```go
mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { ... })
```

## 4. Auth + Security

The security model is machine-pairing plus owner-only local sockets.

- Pairing creates a `MachineID`, `InstallationID`, `AuthToken`, and relay URL
- The config file is written to `~/.gsd-cloud/config.json` with `0600` permissions
- Relay authentication uses `Authorization: Bearer <token>` on the WebSocket
- The token is refreshed before expiry and written back to disk
- The relay URL carries only `machineId` in the query string; the token stays out of URLs
- The local status socket is created with `0600` permissions in a `0700` directory
- Per-task control sockets use a randomly generated bearer token and a private Unix socket path
- Provider credentials are not baked into the binary; the service manager syncs environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`

This is effectively single-user per installation. The code does not show a multi-tenant ACL model; the trust boundary is "the owner of the home directory plus the paired machine token". That is an inference from the filesystem layout and token flow.

Code pointers:

- `internal/api/pair.go`
- `internal/config/config.go`
- `internal/relay/conn.go`
- `internal/sockapi/server.go`
- `internal/agentterminal/control_server.go`

## 5. Storage Layer

There is no SQLite, Postgres, or external database. State lives on the filesystem under `~/.gsd-cloud/`.

Observed durable paths:

- `~/.gsd-cloud/config.json`
- `~/.gsd-cloud/logs/daemon.log`
- `~/.gsd-cloud/daemon.sock`
- `~/.gsd-cloud/pids/*.pid`
- `~/.gsd-cloud/pi-sessions/*.jsonl`
- `~/.gsd-cloud/boot-marker`
- `~/.gsd-cloud/rollback-attempted`
- `~/.gsd-cloud/bin/gsd-cloud`
- `~/.gsd-cloud/bin/pi-extension/`

The README describes session state as a write-ahead log; in the code, the durable session artifact is an append-only per-session JSONL file under `~/.gsd-cloud/pi-sessions/`.

Write pattern:

- config uses atomic-ish rewrite via `os.WriteFile`
- logs are rotated by `lumberjack`
- PID files are created and removed per task
- session files are append-only JSONL

## 6. Network Topology

Production topology is outbound-only from the daemon host.

- outbound WebSocket to `wss://relay.gsd.build/ws/daemon`
- outbound HTTPS to `https://app.gsd.build` for pairing and token refresh
- outbound HTTPS to the relay upload endpoint for bounded image upload
- local listening only on Unix domain sockets

So the daemon does not expose a public TCP port. There is no reverse proxy requirement for the daemon itself. If you need remote orchestration from another machine, you would add a relay, tunnel, or mTLS control plane around it rather than opening the daemon directly to the internet.

The daemon does dial local loopback addresses when proxying preview and local-server-detection traffic, but that is client-side only and not an exposed server port.

## 7. Logging / Observability

Logging is built in, but metrics/tracing are not visible in the code I reviewed.

- `slog` is the core logger
- foreground mode logs text to stderr
- service mode logs JSON to `~/.gsd-cloud/logs/daemon.log`
- `lumberjack` rotates the log file
- log records carry task/session/channel/request/trace correlation fields
- `gsd-cloud logs` tails or filters the daemon log locally
- `gsd-cloud status` and `gsd-cloud workers` query the local socket for live state

The README explicitly says there is no remote raw log streaming or support-bundle upload path today.

## 8. Deployment

Deployment is OS-native service management plus a signed release installer.

- install path: `curl -fsSL https://install.gsd.build | sh`
- install target: `~/.gsd-cloud/bin/gsd-cloud`
- Linux service manager: `systemd --user`
- macOS service manager: `launchd`
- `gsd-cloud install` creates the unit/plist and starts it
- `gsd-cloud start` installs the service if needed, then starts it
- `gsd-cloud update` downloads a signed GitHub release, verifies SHA256SUMS, installs the bundled `pi` extension, and restarts the service
- `gsd-cloud rollback` restores the previous binary if an update fails

No Docker path appeared in the repo. The release workflow builds per-OS binaries and publishes signed assets, and the shell installer verifies the release signature before it copies anything into place.

Code pointers:

- `scripts/install.sh`
- `internal/service/systemd.go`
- `internal/service/launchd.go`
- `internal/update/update.go`
- `.github/workflows/release-daemon.yml`

## 9. Comparison to codex-peers MCP Server Model

| Concern | gsd-daemon | codex-peers MCP server | Gap |
|---|---|---|---|
| Process model | Single Go daemon under OS service manager, with child session workers and warm worker subprocesses | Node MCP server plus detached `codex exec` peer runners, worktree integration, and dashboard | codex-peers lacks a daemon supervisor boundary if moved to another host |
| API | Local Unix-socket HTTP, HTTPS pairing API, and relay WebSocket protocol | MCP tool API plus CLI commands | codex-peers needs a transport layer for remote host control, not just MCP inside the orchestrator |
| Auth | Machine pairing, bearer token, owner-only socket permissions, per-task control tokens | Relies on `CODEX_HOME`, local filesystem, and the orchestrator session; no explicit machine pairing | codex-peers needs a real host auth model if the peer worker runs on a separate machine |
| Storage | Filesystem state under `~/.gsd-cloud/` with config, logs, PIDs, and per-session JSONL | Filesystem state under `~/.codex-peers/` with `state.json`, prompts, runs, and worktrees | codex-peers has richer local state, but not the service-style separation of config/logs/socket/PIDs |
| Network topology | Outbound relay client, no public TCP port | Usually in-process MCP in the orchestrator; not a remote host daemon | cross-machine hosting needs an explicit tunnel/relay or mTLS channel |
| Observability | `slog`, rotated log file, local socket status, `logs` CLI | Dashboard, state file, run logs, peer status, and log tailing | codex-peers needs a daemon-grade health/status endpoint if it becomes a service |
| Deployment | Shell installer, release signatures, systemd/launchd, update/rollback | `npm install`, `npm run build`, and `codex mcp add` | codex-peers needs service install/update discipline, not only package install |
| Orchestration semantics | Session actors, heartbeats, timeouts, warm worker reaping | Peer lifecycle, integration, waiting, and worktree merging | codex-peers already has the orchestration logic, but not the daemon boundary |

Short code pointer:

```ts
case "server":
  await startMcpServer();
```

## 10. Alignment Strategy for "Host codex-peers on a Separate Machine"

1. Copy the daemon boundary, not the relay protocol.
   - Make one long-lived host service own the peer state, worktree lifecycle, and child process supervision.
   - Keep the existing codex-peers worktree/integration logic, but move it behind a daemon process with stable startup and shutdown semantics.

2. Expose an owner-only local API and a separate remote control channel.
   - Local: Unix-socket HTTP for health, state, and admin actions.
   - Remote: authenticated WebSocket or mTLS RPC for orchestrator commands when the supervisor and orchestrator are on different machines.
   - Avoid a public unauthenticated TCP listener.

3. Adopt the daemon’s auth model.
   - Pair the host once with a machine identity.
   - Persist a bearer token with file permissions that match the trust boundary.
   - Use short-lived per-job tokens for any task-specific control socket.
   - Treat local filesystem ownership as part of the security model, not as an incidental detail.

4. Make storage boring and explicit.
   - Put config, logs, state, prompts, and worktrees in separate subdirectories under one home root.
   - Use atomic writes for state.
   - Keep append-only logs for job history.
   - Keep child PID files and socket files ephemeral.

5. Model peers like session actors.
   - One actor per peer/session.
   - Heartbeat, timeout, reaper, and cleanup hooks.
   - Warm workers only if there is a measured latency win.
   - Keep worktree integration as a terminal step after successful peer completion.

6. If the remote orchestrator must reach the host directly, prefer a relay or tunnel over exposing the daemon port.
   - The GSD daemon pattern is outbound-first.
   - For a separate machine deployment, that pattern is the safest default.

## 11. Cost-of-Implementation

Rough order-of-magnitude estimates, assuming the current codex-peers code is the starting point.

| Capability | LOC | deps | risk |
|---|---:|---|---|
| User-level daemon wrapper and service install/update | 200-350 | none beyond stdlib and existing release tooling | low |
| Paired machine auth and persisted config | 150-250 | none or `crypto` only | medium |
| Local Unix-socket health/status/admin API | 100-200 | none | low |
| Remote control transport for a separate machine | 250-500 | likely `websocket` or mTLS plumbing | high |
| Peer/session actor supervisor with heartbeats and reaping | 500-1000 | none if reusing current worktree and process helpers | high |
| Structured logging, log filtering, and status CLI | 100-200 | none | low |
| Release/install/rollback packaging for the host daemon | 200-400 | shell + release tooling | medium |

## Sources

GSD daemon:

- [README](https://github.com/gsd-build/daemon/blob/main/README.md)
- [main.go](https://github.com/gsd-build/daemon/blob/main/main.go)
- [cmd/start.go](https://github.com/gsd-build/daemon/blob/main/cmd/start.go)
- [cmd/login.go](https://github.com/gsd-build/daemon/blob/main/cmd/login.go)
- [internal/config/config.go](https://github.com/gsd-build/daemon/blob/main/internal/config/config.go)
- [internal/loop/daemon.go](https://github.com/gsd-build/daemon/blob/main/internal/loop/daemon.go)
- [internal/sockapi/server.go](https://github.com/gsd-build/daemon/blob/main/internal/sockapi/server.go)
- [internal/sockapi/handler.go](https://github.com/gsd-build/daemon/blob/main/internal/sockapi/handler.go)
- [internal/relay/conn.go](https://github.com/gsd-build/daemon/blob/main/internal/relay/conn.go)
- [internal/relay/pumps.go](https://github.com/gsd-build/daemon/blob/main/internal/relay/pumps.go)
- [internal/api/pair.go](https://github.com/gsd-build/daemon/blob/main/internal/api/pair.go)
- [internal/service/systemd.go](https://github.com/gsd-build/daemon/blob/main/internal/service/systemd.go)
- [internal/service/launchd.go](https://github.com/gsd-build/daemon/blob/main/internal/service/launchd.go)
- [internal/service/env.go](https://github.com/gsd-build/daemon/blob/main/internal/service/env.go)
- [internal/logging/logging.go](https://github.com/gsd-build/daemon/blob/main/internal/logging/logging.go)
- [internal/logging/context.go](https://github.com/gsd-build/daemon/blob/main/internal/logging/context.go)
- [internal/session/manager.go](https://github.com/gsd-build/daemon/blob/main/internal/session/manager.go)
- [internal/session/actor.go](https://github.com/gsd-build/daemon/blob/main/internal/session/actor.go)
- [internal/session/pi_session.go](https://github.com/gsd-build/daemon/blob/main/internal/session/pi_session.go)
- [internal/agentterminal/control_server.go](https://github.com/gsd-build/daemon/blob/main/internal/agentterminal/control_server.go)
- [internal/pi/worker.go](https://github.com/gsd-build/daemon/blob/main/internal/pi/worker.go)
- [internal/upload/upload.go](https://github.com/gsd-build/daemon/blob/main/internal/upload/upload.go)
- [scripts/install.sh](https://github.com/gsd-build/daemon/blob/main/scripts/install.sh)
- [.github/workflows/release-daemon.yml](https://github.com/gsd-build/daemon/blob/main/.github/workflows/release-daemon.yml)

codex-peers:

- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/README.md](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/README.md)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/package.json](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/package.json)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/index.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/index.ts)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/mcpServer.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/mcpServer.ts)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/runner.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/runner.ts)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/paths.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/paths.ts)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/store.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/store.ts)
- [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/peerManager.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/479f7cca/src/peerManager.ts)
