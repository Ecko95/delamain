# cc-connect transport layer evaluation

## 1. Overview

cc-connect is a Go-based bridge that connects local AI agents to chat platforms and a browser-based admin UI. Its README describes support for Telegram, Slack, Discord, Feishu/Lark, DingTalk, LINE, WeCom, Weibo, personal Weixin, QQ, and QQ Bot, plus 10+ agent backends. It is positioned as a transport layer rather than an agent runner.

License: MIT, per the repository README. The GitHub contents API did not surface a machine-readable `LICENSE` file, so this is a README-declared license rather than an inferred SPDX record.

## 2. Transport architecture

The transport stack is split cleanly between a core protocol layer and per-platform adapters.

- `core/interfaces.go` defines the platform contract: `Platform` (`Start`, `Reply`, `Send`, `Stop`) plus optional capabilities such as `ReplyContextReconstructor`, `TypingIndicator`, `ImageSender`, `FileSender`, `MessageUpdater`, `CardSender`, `CardNavigable`, and `CardRefresher`.
- `core/bridge.go` implements the central WebSocket bridge. `BridgeServer` accepts adapter registrations, keeps a map of `platform -> adapter`, keeps a map of `project -> engine`, and routes messages back to the owning engine.
- `core/bridge.go` also exposes REST session endpoints under `/bridge/sessions` and `/bridge/sessions/{id}` so external clients can inspect, create, switch, and delete sessions.
- `core/bridge_capabilities.go` publishes a capabilities snapshot so bridge clients can discover the host build and which commands are safe to expose.
- `core/api.go` is the adjacent local Unix-socket API for send/cron/relay operations; it uses the same engine/session model but is separate from the chat bridge.

The important pattern is that the transport boundary is explicit. Platforms do not talk to engines directly; they register on the bridge, send normalized JSON messages, and let the bridge decide which engine owns a session.

Code pointers:

- [`core/interfaces.go`](https://github.com/chenhg5/cc-connect/blob/main/core/interfaces.go)
- [`core/bridge.go`](https://github.com/chenhg5/cc-connect/blob/main/core/bridge.go)
- [`core/bridge_capabilities.go`](https://github.com/chenhg5/cc-connect/blob/main/core/bridge_capabilities.go)
- [`core/api.go`](https://github.com/chenhg5/cc-connect/blob/main/core/api.go)

## 3. Per-platform adapter pattern

Each adapter owns the vendor-specific receive loop and reply semantics, but implements the same core interface.

Telegram is a good example:

- `platform/telegram/telegram.go` requires a bot `token`, validates `allow_from`, and supports optional proxy settings, `group_reply_all`, `share_session_in_channel`, and reactions.
- It uses Telegram long polling, not webhooks, so no public URL is needed.
- It turns incoming updates into normalized `core.Message` objects, including images, voice/audio, documents, location, and callback queries.
- It derives session keys from chat ID, thread ID, and optionally user ID, so a Telegram chat can be shared or per-user depending on config.
- It implements rich reply behavior: HTML-safe text fallback, inline buttons, preview start/update, typing actions, audio/image/file sending, and reply-context reconstruction.

Slack follows the same adapter shape with different transport mechanics:

- `platform/slack/slack.go` requires both `bot_token` and `app_token`.
- It uses Socket Mode plus Events API callbacks.
- It handles app mentions, regular messages, slash commands, and assistant-thread start events.
- Its reply context is simpler: `channel + timestamp`, which Slack uses for threaded replies.
- It supports uploads, observations, mrkdwn formatting guidance, and reaction-based typing indicators.

The abstract contract is the same, but the concrete transport behavior is vendor-specific.

Code pointers:

- [`platform/telegram/telegram.go`](https://github.com/chenhg5/cc-connect/blob/main/platform/telegram/telegram.go)
- [`platform/slack/slack.go`](https://github.com/chenhg5/cc-connect/blob/main/platform/slack/slack.go)

## 4. Auth + credential model

cc-connect stores credentials in a single TOML config tree, not in a separate secret manager.

- Top-level service auth lives in `Config.Bridge.Token`, `Config.Management.Token`, and `Config.Webhook.Token`.
- Platform credentials live under each `[[projects]].[[projects.platforms]]` block as arbitrary key/value entries in `PlatformConfig.Options`.
- The config model is project-scoped, so one process can host multiple projects, each with its own agent config and platform list.
- Feishu/Lark setup helpers rewrite `config.toml` atomically and persist `app_id` / `app_secret` back into the right project/platform block.
- Weixin setup writes `token` plus optional `base_url`, `cdn_base_url`, and `account_id` into the project config.
- There is no evidence of encrypted-at-rest secret storage, per-user secret cache, or multi-tenant credential isolation beyond project boundaries.

The practical result is:

- Credentials are cleartext in config.
- Multi-tenant means “multiple projects in one daemon,” not “separate tenant vaults.”
- Platform allowlists such as `allow_from` are authorization gates, not credential stores.

Code pointers:

- [`config/config.go`](https://github.com/chenhg5/cc-connect/blob/main/config/config.go)
- [`core/setup.go`](https://github.com/chenhg5/cc-connect/blob/main/core/setup.go)
- [`README.md`](https://github.com/chenhg5/cc-connect/blob/main/README.md)

## 5. Comparison vs the in-flight controlPlane/telegram.ts

The local supervisor branch is a peer-orchestration system, not a transport framework.

- `src/types.ts` tracks peer lifecycle state, worktree metadata, engine choice, integration status, and the GSD-specific states added in the current branch.
- `README.md` explains that the supervisor forwards `CODEX_HOME` so spawned peers can find `auth.json` and `config.toml`, which is local runner auth rather than chat-platform auth.
- `src/mcpServer.ts` exposes peer-management tools such as `spawn_peer`, `wait_for_peer`, `peer_status`, and `send_peer_reply`; it is a local control API, not a platform bridge.

Compared with the in-flight Telegram control-plane file described in the task, cc-connect already provides the transport pieces that a custom poller usually reinvents:

- Telegram receive loop and reconnect policy
- Session-key derivation from chat/thread/user identity
- Reply reconstruction for proactive sends
- Message routing from platform events into the engine
- Rich media, callback, and typing support

What cc-connect does not replace is the supervisor domain:

- worktree creation and merge targeting
- Codex/Cursor spawning and session lifecycle
- peer persistence, integration, and GSD state transitions

So the overlap is transport, not orchestration.

Code pointers:

- [`src/types.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/src/types.ts)
- [`src/mcpServer.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/src/mcpServer.ts)
- [`README.md`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/README.md)

## 6. Replacement vs co-existence

For the Telegram transport slice, cc-connect could replace most of a bespoke `controlPlane/telegram.ts` implementation.

Rough estimate:

- If the current file is really a single monolithic Telegram adapter and poller, cc-connect could remove roughly 14k-18k LOC of transport, callback, media, formatting, and session-routing code.
- If that file also contains supervisor-specific policy, the removal drops, because cc-connect does not know about peer spawn, worktree integration, or local Codex/Cursor lifecycle.

My read is that this should be treated as co-existence at the system level and replacement at the transport slice:

- Keep the supervisor and peer runtime in this repo.
- Move Telegram transport responsibilities to cc-connect, or at least copy its transport patterns.
- Do not expect cc-connect to subsume the orchestration layer.

## 7. Cost of integration

| Integration mode | LOC delta | New deps | Risk |
|---|---:|---|---|
| Full replacement of the custom Telegram transport with cc-connect as a sidecar | `-14k to -18k` in the Telegram slice; potentially more if the current file is transport-heavy | cc-connect binary/service, bridge protocol client, config/token mapping | High |
| Co-exist: keep the supervisor, delegate chat transport to cc-connect | `+300 to +900` glue LOC | WebSocket or process wrapper, cc-connect config, bridge token | Medium |
| Borrow patterns only: keep current Telegram code, adopt cc-connect abstractions | `-200 to +500` | None | Low |

## 8. Recommendation

Recommendation: co-exist, with transport borrowing first.

Reasoning:

- cc-connect already solves the hard chat-transport problems, especially Telegram and Slack.
- The local supervisor branch is fundamentally about peer orchestration, not chat transport, so a whole-repo replacement would be the wrong boundary.
- The best ROI is to keep orchestration here, externalize or refactor the Telegram transport slice, and adopt cc-connect’s `Platform` / optional-capability split as the design template.

If the goal is strictly “remove the custom Telegram poller,” then replacement is viable. If the goal is “replace the supervisor’s control plane,” it is not.

## Sources

- Local baseline: [`README.md`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/README.md), [`src/types.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/src/types.ts), [`src/mcpServer.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/5bdbcb58/src/mcpServer.ts)
- cc-connect overview: [`README.md`](https://github.com/chenhg5/cc-connect/blob/main/README.md)
- cc-connect transport contract: [`core/interfaces.go`](https://github.com/chenhg5/cc-connect/blob/main/core/interfaces.go), [`core/bridge.go`](https://github.com/chenhg5/cc-connect/blob/main/core/bridge.go), [`core/bridge_capabilities.go`](https://github.com/chenhg5/cc-connect/blob/main/core/bridge_capabilities.go), [`core/api.go`](https://github.com/chenhg5/cc-connect/blob/main/core/api.go)
- cc-connect Telegram adapter: [`platform/telegram/telegram.go`](https://github.com/chenhg5/cc-connect/blob/main/platform/telegram/telegram.go)
- cc-connect Slack adapter: [`platform/slack/slack.go`](https://github.com/chenhg5/cc-connect/blob/main/platform/slack/slack.go)
- cc-connect config and setup helpers: [`config/config.go`](https://github.com/chenhg5/cc-connect/blob/main/config/config.go), [`core/setup.go`](https://github.com/chenhg5/cc-connect/blob/main/core/setup.go)
