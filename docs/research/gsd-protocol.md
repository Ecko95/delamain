# GSD protocol-go inventory and alignment notes

Scope: repository inventory for `gsd-build/protocol-go`, based on the Go types, wire-spec markdown, tests, and package docs in this repo. There are no `.proto` or JSON Schema files in the tree; the contract is defined by Go structs plus `PROTOCOL.md`.

## 1. Overview

`protocol-go` is the Go binding for the GSD Cloud wire protocol. The protocol is a custom WebSocket message protocol using JSON text frames, not gRPC, JSON-RPC, MCP, or protobuf.

- Transport: WebSocket text frames
- Serialization: JSON objects with a required `type` discriminator
- Parsing model: envelope-first, then type-directed unmarshal into a concrete struct
- Compatibility model: additive JSON fields are ignored by receivers; unknown `type` values are rejected
- License: MIT

The repo contains:

- `PROTOCOL.md`: authoritative wire specification
- `messages.go`: message types, enums, and comments
- `envelope.go`, `limits.go`, `binding.go`, `trace.go`: parsing and validation helpers
- tests that lock in compatibility and hardening behavior

The wire protocol is versioned at `1` in `PROTOCOL.md`.

## 2. Full RPC verb inventory

This protocol is message-based, not a strict request/response RPC system. The `output` column below means the correlated reply or follow-on notification(s), not necessarily a single synchronous response.

### Browser / client -> daemon

| Verb | Direction | Input | Output | Error codes / notes |
|---|---|---|---|---|
| `task` | client -> daemon | `Task` | `taskStarted`, `stream`, `taskLifecycle`, `taskComplete`, `taskError`, `taskCancelled`, `permissionRequest`, `question`, `contextStats`, `compactStatus`, `localServerDetected` | No dedicated code enum; terminal task failures use free-form `failureCode` / `error` fields. |
| `stop` | client -> daemon | `Stop` | `taskCancelled` or `taskError` | No code enum; interrupt semantics are capability-gated by `hello.capabilities.stop`. |
| `permissionResponse` | client -> daemon | `PermissionResponse` | Task continues or aborts; no direct ack frame | No code enum; consumed by the active task attempt. |
| `questionResponse` | client -> daemon | `QuestionResponse` | Task continues or aborts; no direct ack frame | No code enum; consumed by the active task attempt. |
| `compactRequest` | client -> daemon | `CompactRequest` | `compactStatus` | Status enum is `started` / `completed` / `failed`; failure text is free-form. |
| `contextStatsRequest` | client -> daemon | `ContextStatsRequest` | `contextStats` | No error frame defined; transport failure only. |
| `browseDir` | client -> daemon | `BrowseDir` | `BrowseDirResult` | `BrowseDirResult.error` is free-form. Pagination is optional. |
| `readFile` | client -> daemon | `ReadFile` | `ReadFileResult` | `ReadFileResult.error` is free-form. |
| `mkDir` | client -> daemon | `MkDir` | `MkDirResult` | `MkDirResult.error` is free-form. |
| `listSkills` | client -> daemon | `ListSkills` | `ListSkillsResult` | `ListSkillsResult.error` is free-form. Requires `hello.capabilities.skills`. |

### Daemon -> browser / client

| Verb | Direction | Input | Output | Error codes / notes |
|---|---|---|---|---|
| `stream` | daemon -> client | `Stream` | Opaque Claude event stream | No code enum; `event` is raw JSON and `sequenceNumber` orders delivery. |
| `taskLifecycle` | daemon -> client | `TaskLifecycle` | Lifecycle diagnostics only | `phase` and `status` are enums; `failureCode` is free-form. |
| `taskStarted` | daemon -> client | `TaskStarted` | Correlated task-start notice | No code enum. |
| `taskComplete` | daemon -> client | `TaskComplete` | Final success notice | No code enum. |
| `taskError` | daemon -> client | `TaskError` | Final failure notice | `failureCode` is free-form; `retryable` is a boolean hint. |
| `taskCancelled` | daemon -> client | `TaskCancelled` | Final cancellation notice | `failureCode` is free-form; `retryable` is a boolean hint. |
| `permissionRequest` | daemon -> client | `PermissionRequest` | Waits for `permissionResponse` | No code enum; `toolInput` is raw JSON. |
| `question` | daemon -> client | `Question` | Waits for `questionResponse` | No code enum; structured options are optional. |
| `contextStats` | daemon -> client | `ContextStats` | Context window status | No error frame; `tokens` / `percent` can be null immediately after compaction. |
| `compactStatus` | daemon -> client | `CompactStatus` | Compact progress/status | `status` enum: `started`, `completed`, `failed`; `reason` enum: `manual`, `threshold`, `overflow`; `error` free-form. |
| `heartbeat` | daemon -> client | `Heartbeat` | Presence pulse | No code enum; `status` is currently expected to be `online`. |
| `browseDirResult` | daemon -> client | `BrowseDirResult` | Directory listing reply | `error` free-form; `ok=false` indicates failure. |
| `readFileResult` | daemon -> client | `ReadFileResult` | File content reply | `error` free-form; `truncated` marks bounded reads. |
| `mkDirResult` | daemon -> client | `MkDirResult` | Directory creation reply | `error` free-form. |
| `listSkillsResult` | daemon -> client | `ListSkillsResult` | Skill inventory reply | `error` free-form. |
| `machineStatus` | daemon -> client | `MachineStatus` | Machine presence update | `state` / `previousState` are free-form strings; examples in tests include `online` and `reconnecting`. |
| `localServerDetected` | daemon -> client | `LocalServerDetected` | Loopback server discovery event | No code enum; source is currently `tool_output`. |
| `terminalOpened` | daemon -> client | `TerminalOpened` | PTY open acknowledgement | No code enum. |
| `terminalOutput` | daemon -> client | `TerminalOutput` | Live PTY output chunk | No code enum; `seq` orders output. |
| `terminalSnapshot` | daemon -> client | `TerminalSnapshot` | Scrollback snapshot | No code enum; `seq` orders snapshots. |
| `terminalExit` | daemon -> client | `TerminalExit` | PTY process completion | No code enum; `reason` is free-form. |
| `terminalError` | daemon -> client | `TerminalError` | PTY lifecycle / auth error | No code enum; `error` is free-form. |
| `agentTerminalStarted` | daemon -> client | `AgentTerminalStarted` | Agent PTY job start event | `status` and readiness values are enums/free-form; see section 3. |
| `agentTerminalUpdated` | daemon -> client | `AgentTerminalUpdated` | Agent PTY job progress event | Same as above. |

### Relay / transport control and preview streaming

| Verb | Direction | Input | Output | Error codes / notes |
|---|---|---|---|---|
| `hello` | daemon -> relay | `Hello` | `welcome` | Handshake frame; `capabilities` advertises optional support. |
| `welcome` | relay -> daemon | `Welcome` | Handshake complete | `latestDaemonVersion` is only an update hint. |
| `previewOpen` | client -> daemon | `PreviewOpen` | `PreviewOpenResult` | `OK=false` carries `errorCode` and `message`; code values are free-form. |
| `previewOpenResult` | daemon -> client | `PreviewOpenResult` | Confirms preview registration | `errorCode` is free-form. |
| `previewClose` | client -> daemon | `PreviewClose` | Preview teardown | `reason` is free-form. |
| `previewHttpRequest` | daemon -> client | `PreviewHTTPRequest` | `previewHTTPResponseHead` + `previewStreamChunk` | No code enum; request/response bodies flow over `streamId`. |
| `previewHttpResponseHead` | daemon -> client | `PreviewHTTPResponseHead` | Response head for an HTTP preview stream | No code enum. |
| `previewStreamChunk` | client <-> daemon | `PreviewStreamChunk` | Body chunks for HTTP preview streams | No code enum; `sequence` orders chunks and `final` ends the stream. |
| `previewStreamCancel` | client <-> daemon | `PreviewStreamCancel` | Cancels local preview I/O | `reason` is free-form. |
| `previewWebSocketOpen` | client -> daemon | `PreviewWebSocketOpen` | `PreviewWebSocketOpenResult` | No code enum; requested subprotocols are optional. |
| `previewWebSocketOpenResult` | client -> daemon | `PreviewWebSocketOpenResult` | Confirms WebSocket preview setup | `errorCode` is free-form; `protocol` is the negotiated subprotocol. |
| `previewWebSocketData` | client <-> daemon | `PreviewWebSocketData` | Bidirectional WebSocket payload relay | No code enum; `sequence` orders frames, `isBinary` selects text vs binary payload interpretation. |
| `previewWebSocketClose` | client <-> daemon | `PreviewWebSocketClose` | Closes the remote WebSocket | `code` and `reason` are pass-through close metadata. |
| `terminalOpen` | client -> daemon | `TerminalOpen` | `TerminalOpened` or `TerminalError` | Browser-originated opens carry `token`; daemon-bound opens carry server-side terminal metadata. |
| `terminalInput` | client -> daemon | `TerminalInput` | `terminalOutput`, `terminalSnapshot`, `terminalExit`, `terminalError` | Raw bytes are base64 encoded. |
| `terminalResize` | client -> daemon | `TerminalResize` | PTY resize side effect | No code enum. |
| `terminalClose` | client -> daemon | `TerminalClose` | `terminalExit` or `terminalError` | No code enum. |
| `agentTerminalAttach` | client -> daemon | `AgentTerminalAttach` | Attaches browser to an existing agent PTY | No code enum. |
| `agentTerminalSnapshotRequest` | client -> daemon | `AgentTerminalSnapshotRequest` | Triggers a fresh `terminalSnapshot` | No code enum. |

Stable code-like vocab in the protocol is limited to these enums:

- `TurnKind`: `user`, `session_title`, `context_stats`, `compact`, `control`
- `TaskLifecyclePhase`: `accepted`, `queued`, `started`, `pi_started`, `prompt_written`, `first_event_seen`, `first_visible_event_seen`, `streaming`, `tool_started`, `tool_finished`, `waiting_input`, `input_received`, `cleanup_started`, `cleanup_finished`, `heartbeat`, `retry_scheduled`, `completed`, `failed`, `canceled`, `timed_out`, `lost`
- `TaskAttemptStatus`: `created`, `queued`, `started`, `pi_started`, `prompt_written`, `first_event_seen`, `first_visible_event_seen`, `streaming`, `waiting_input`, `tool_running`, `cleanup_started`, `cleanup_finished`, `completed`, `failed`, `canceled`, `timed_out`, `lost`
- `CompactReason`: `manual`, `threshold`, `overflow`
- `CompactLifecycleStatus`: `started`, `completed`, `failed`
- `AgentTerminalReadiness.state`: `unknown`, `waiting`, `ready`, `timed_out`, `failed`
- `AgentTerminalReadiness.source`: `pattern`, `port`, `url`, `process_exit`, `heuristic`
- `agentTerminalStarted.status` / `agentTerminalUpdated.status`: `starting`, `running`, `ready`, `exited`, `failed`, `killed`

Everything else that looks like an error code is a free-form string field: `error`, `errorCode`, `failureCode`, or `reason`.

## 3. Core message types

### Supporting types and enums

| Type | Fields / values | Meaning |
|---|---|---|
| `ContextRef` | `kind`, `path`, `name`, `size?`, `modifiedAt?` | Project-relative file/folder reference attached to a task. |
| `TaskDeadlines` | `processStartMs?`, `promptWriteMs?`, `firstEventMs?`, `firstVisibleEventMs?`, `streamIdleMs?`, `toolIdleMs?`, `userInputMs?`, `cleanupTermMs?` | Millisecond budget profile for task supervision. |
| `TurnKind` | `user`, `session_title`, `context_stats`, `compact`, `control` | Classifies task turns so control flows can be separated from user work. |
| `TaskLifecyclePhase` | see section 2 | Detailed lifecycle phase for task-attempt diagnostics. |
| `TaskAttemptStatus` | see section 2 | Durable attempt status used by the relay and UI. |
| `CompactReason` | `manual`, `threshold`, `overflow` | Why context compaction happened. |
| `CompactLifecycleStatus` | `started`, `completed`, `failed` | Lifecycle state for a compaction run. |
| `QuestionOption` | `label`, `description?`, `preview?` | Structured answer choice for user questions. |
| `BrowseEntry` | `name`, `path`, `isDirectory`, `size`, `modifiedAt` | One row in a directory listing. |
| `Skill` | `name`, `description?`, `path`, `scope` | Installed skill metadata returned by `listSkills`. |
| `AgentTerminalReadiness` | `state`, `source?`, `matchedText?`, `readyAt?`, `timeoutMs?` | Readiness detector state for an agent-owned terminal job. |
| `AgentTerminalPort` | `host`, `port`, `url` | Loopback port discovered by an agent job. |
| `HelloCapabilities` | `stop?`, `terminal?`, `agentTerminalJobs?`, `contextRefs?`, `previewTunnel?`, `previewMaxFrameBytes?`, `previewChunkBytes?`, `previewWebSocketProtocols?`, `localServerDetection?`, `skills?` | Optional daemon feature flags and size limits advertised during handshake. |
| `Binding` | `RequestID`, `SessionID`, `ChannelID`, `MachineID`, `PreviewID`, `StreamID`, `TerminalID`, `TaskID` | Correlation fields extracted from a message or envelope for request/session matching. |
| `Envelope` | `Type`, `Payload` | Parser wrapper used after the `type` field is inspected. Not a wire field itself. |
| `EnvelopeLimits` | `MaxFrameBytes`, `MaxDepth`, `MaxObjectFields`, `MaxArrayItems` | Pre-unmarshal JSON frame hardening limits. |

### Messages

| Type | Fields | Meaning |
|---|---|---|
| `Task` | `type`, `taskId`, `sessionId`, `channelId`, `attemptId?`, `attemptNumber?`, `leaseExpiresAt?`, `deadlineProfile?`, `turnKind?`, `prompt`, `engine?`, `provider?`, `model`, `effort`, `permissionMode`, `cwd`, `claudeSessionId?`, `requestId?`, `traceparent?`, `imageUrls?`, `contextRefs?`, `customInstructions?`, `disableSkills?` | Dispatches a user turn to the daemon. `engine` defaults to `pi`; `provider` defaults to `claude-cli`; `contextRefs` and `disableSkills` are optional capabilities. |
| `TaskLifecycle` | `type`, `taskId`, `attemptId`, `attemptNumber`, `sessionId`, `channelId`, `phase`, `status`, `retryable?`, `failureCode?`, `message?`, `userMessage?`, `observedAt`, `deadlineAt?`, `pid?`, `provider?`, `model?`, `requestId?`, `traceparent?` | Structured diagnostics for an attempt. This is the high-fidelity state feed for retries, deadlines, and terminal outcomes. |
| `Stop` | `type`, `channelId`, `sessionId` | Requests cancellation of the active task for a session. |
| `PermissionResponse` | `type`, `channelId`, `sessionId`, `requestId`, `approved` | Replies to a `permissionRequest`. |
| `QuestionResponse` | `type`, `channelId`, `sessionId`, `requestId`, `answer` | Replies to a `question`. |
| `BrowseDir` | `type`, `requestId`, `channelId`, `machineId`, `path`, `limit?`, `cursor?` | Requests a directory listing from the daemon's filesystem. |
| `ReadFile` | `type`, `requestId`, `channelId`, `machineId`, `path`, `maxBytes?` | Reads file content from the daemon's filesystem. |
| `CompactRequest` | `type`, `sessionId`, `channelId`, `requestId`, `instructions?` | Requests Pi context compaction for a session. |
| `ContextStatsRequest` | `type`, `sessionId`, `channelId`, `requestId` | Requests current Pi context statistics. |
| `Stream` | `type`, `taskId?`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `sequenceNumber`, `event`, `requestId?`, `traceparent?` | Carries one opaque Claude event plus a sequence number. `event` is raw JSON from the runtime stream. |
| `TaskStarted` | `type`, `taskId`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `startedAt`, `requestId?`, `traceparent?` | Signals that processing has begun. |
| `TaskComplete` | `type`, `taskId`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `claudeSessionId`, `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `requestId?`, `traceparent?` | Final success metadata for a task attempt. |
| `TaskError` | `type`, `taskId`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `error`, `failureCode?`, `retryable?`, `userMessage?`, `requestId?`, `traceparent?` | Final failure metadata for a task attempt. |
| `TaskCancelled` | `type`, `taskId`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `failureCode?`, `retryable?`, `userMessage?`, `requestId?`, `traceparent?` | Final cancellation notice, typically after user interrupt. |
| `PermissionRequest` | `type`, `taskId?`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `requestId`, `toolName`, `toolInput` | Asks the browser/user to approve a tool call. |
| `Question` | `type`, `taskId?`, `attemptId?`, `attemptNumber?`, `sessionId`, `channelId`, `requestId`, `question`, `header?`, `multiSelect?`, `options?` | Asks the user for input, optionally with structured choices. |
| `ContextStats` | `type`, `sessionId`, `channelId`, `requestId?`, `tokens?`, `contextWindow`, `percent?`, `reserveTokens`, `keepRecentTokens`, `autoThresholdPercent`, `source`, `observedAt` | Pi context usage snapshot. `tokens` and `percent` can be null immediately after compaction. |
| `CompactStatus` | `type`, `sessionId`, `channelId`, `requestId`, `status`, `reason`, `instructions?`, `tokensBefore?`, `tokensAfter?`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `autoThresholdPercent`, `summary?`, `firstKeptEntryId?`, `error?`, `source`, `observedAt` | Progress / result frame for compaction. |
| `Heartbeat` | `type`, `machineId`, `daemonVersion`, `status`, `timestamp` | Daemon health pulse. |
| `BrowseDirResult` | `type`, `requestId`, `channelId`, `ok`, `entries?`, `hasMore?`, `nextCursor?`, `error?` | Directory listing response, optionally paginated. |
| `MkDir` | `type`, `requestId`, `channelId`, `machineId`, `path` | Requests directory creation. |
| `ListSkills` | `type`, `requestId`, `channelId`, `machineId`, `cwd` | Requests local skill discovery for a working directory. |
| `ListSkillsResult` | `type`, `requestId`, `channelId`, `ok`, `skills?`, `error?` | Returns discovered skills and their bounded metadata. |
| `MkDirResult` | `type`, `requestId`, `channelId`, `ok`, `error?` | Directory creation response. |
| `ReadFileResult` | `type`, `requestId`, `channelId`, `ok`, `content?`, `truncated?`, `error?` | File read response. |
| `TerminalOpen` | `type`, `requestId`, `terminalId?`, `sessionId`, `channelId`, `token?`, `cwd?`, `cols`, `rows`, `idleTimeoutMs?`, `maxLifetimeMs?` | Opens a chat-scoped PTY terminal. Browser-originated opens carry `token`; daemon-side opens can carry a server-generated `terminalId`. |
| `TerminalOpened` | `type`, `requestId`, `terminalId`, `sessionId`, `channelId`, `shell`, `cwd`, `startedAt` | Confirms terminal creation. |
| `TerminalInput` | `type`, `terminalId`, `channelId`, `dataBase64` | Base64-encoded input bytes sent to the PTY. |
| `TerminalOutput` | `type`, `terminalId`, `sessionId`, `channelId`, `seq`, `dataBase64` | Base64-encoded PTY output bytes. |
| `TerminalSnapshot` | `type`, `terminalId`, `sessionId`, `channelId`, `seq`, `dataBase64` | Bounded scrollback snapshot. |
| `TerminalResize` | `type`, `terminalId`, `channelId`, `cols`, `rows` | Resizes the PTY. |
| `TerminalClose` | `type`, `terminalId`, `channelId` | Requests PTY shutdown. |
| `TerminalExit` | `type`, `terminalId`, `sessionId`, `channelId`, `exitCode?`, `signal?`, `reason`, `endedAt` | PTY process completion metadata. |
| `TerminalError` | `type`, `requestId?`, `terminalId?`, `sessionId?`, `channelId`, `error` | Terminal lifecycle or authorization error. |
| `AgentTerminalStarted` | `type`, `jobId`, `terminalId`, `sessionId`, `channelId`, `taskId?`, `toolCallId?`, `projectId`, `commandPreview`, `title`, `cwd`, `status`, `readiness`, `ports?`, `urls?`, `seq?`, `startedAt` | Daemon-owned agent PTY job start event. |
| `AgentTerminalUpdated` | `type`, `jobId`, `terminalId`, `sessionId`, `channelId`, `status`, `readiness`, `ports?`, `urls?`, `seq?`, `updatedAt` | Agent PTY job progress event. |
| `AgentTerminalAttach` | `type`, `terminalId`, `channelId` | Browser attach request for an agent PTY. |
| `AgentTerminalSnapshotRequest` | `type`, `terminalId`, `channelId` | Browser request for a fresh agent PTY snapshot. |
| `Hello` | `type`, `machineId`, `daemonVersion`, `os`, `arch`, `activeTasks?`, `capabilities?` | First frame sent by a daemon after connect; advertises identity and supported features. |
| `Welcome` | `type`, `latestDaemonVersion?` | Relay response to `hello`; can be used as an update hint. |
| `MachineStatus` | `type`, `machineId`, `state`, `previousState?`, `reason?`, `occurredAt` | Presence-state update for a daemon machine. |
| `PreviewOpen` | `type`, `requestId`, `previewId`, `sessionId`, `channelId`, `machineId`, `targetHost`, `targetPort`, `expiresAt` | Registers an owner-approved loopback target for preview traffic. |
| `PreviewOpenResult` | `type`, `requestId`, `previewId`, `ok`, `errorCode?`, `message?` | Acknowledges or rejects a preview open request. |
| `PreviewClose` | `type`, `previewId`, `reason` | Revokes a preview registration. |
| `PreviewHTTPRequest` | `type`, `requestId`, `streamId`, `previewId`, `method`, `path`, `headers?` | HTTP request head for preview tunneling; body bytes flow on `PreviewStreamChunk`. |
| `PreviewHTTPResponseHead` | `type`, `requestId`, `streamId`, `previewId`, `statusCode`, `headers?` | HTTP response head for preview tunneling. |
| `PreviewStreamChunk` | `type`, `streamId`, `sequence`, `bodyBase64`, `final` | Raw body chunk for an HTTP preview stream. |
| `PreviewStreamCancel` | `type`, `streamId`, `reason` | Cancels preview stream I/O. |
| `PreviewWebSocketOpen` | `type`, `streamId`, `previewId`, `path`, `headers?`, `protocols?` | Opens a loopback WebSocket target. |
| `PreviewWebSocketOpenResult` | `type`, `streamId`, `previewId`, `ok`, `protocol?`, `errorCode?`, `message?` | Confirms or rejects the WebSocket open. |
| `PreviewWebSocketData` | `type`, `streamId`, `sequence`, `isBinary`, `bodyBase64` | Data frame relay for preview WebSocket traffic. |
| `PreviewWebSocketClose` | `type`, `streamId`, `code?`, `reason?` | WebSocket close notification. |
| `LocalServerDetected` | `type`, `sessionId`, `channelId`, `taskId?`, `toolUseId?`, `host`, `port`, `url`, `command?`, `source`, `detectedAt` | Loopback server detection event emitted by the daemon after verification. |

## 4. State machine

The protocol implies several overlapping state machines.

### Task / attempt lifecycle

1. Browser sends `task`.
2. Relay marks an attempt `accepted` / `queued`.
3. Daemon emits `taskStarted` and `taskLifecycle` with `started`.
4. Runtime progresses through `pi_started`, `prompt_written`, `first_event_seen`, `first_visible_event_seen`, `streaming`.
5. During execution the daemon may emit `permissionRequest`, `question`, `contextStats`, `compactStatus`, `stream`, `localServerDetected`, and tool-specific notifications.
6. The attempt transitions through `tool_started` / `tool_finished` / `waiting_input` / `input_received` / `cleanup_started` / `cleanup_finished`.
7. Terminal states are `completed`, `failed`, `canceled`, `timed_out`, or `lost`, with matching `TaskComplete`, `TaskError`, or `TaskCancelled` frames when appropriate.

`stop` can cut directly across the running state and push the attempt toward cancellation. Retry safety is encoded per attempt via `retryable` and `failureCode`.

### Terminal lifecycle

1. Browser or relay sends `terminalOpen`.
2. Daemon acknowledges with `terminalOpened` or rejects with `terminalError`.
3. Input/resize/close are sent via `terminalInput`, `terminalResize`, `terminalClose`.
4. Live output arrives as `terminalOutput` and occasional `terminalSnapshot`.
5. The terminal ends with `terminalExit` or `terminalError`.

### Agent terminal lifecycle

1. Daemon reports `agentTerminalStarted`.
2. Progress updates arrive as `agentTerminalUpdated`.
3. Browser may attach or request a snapshot.
4. Stream bytes still use the existing terminal data plane.
5. Terminal status settles on `ready`, `exited`, `failed`, or `killed`.

### Preview lifecycle

1. A preview is opened with `previewOpen`.
2. The daemon replies with `previewOpenResult`.
3. HTTP or WebSocket traffic is forwarded over the preview stream primitives.
4. Either side can cancel via `previewStreamCancel` or close via `previewClose`.

### Presence and machine state

`hello` / `welcome` establish daemon identity and negotiated capability. `heartbeat` keeps the machine presence fresh, and `machineStatus` broadcasts changes such as reconnecting or offline transitions.

## 5. Streaming model

The stream model is intentionally lightweight:

- The wire format is best-effort WebSocket text delivery.
- `stream` carries opaque runtime JSON events and uses `sequenceNumber` to order them.
- `terminalOutput`, `terminalSnapshot`, `previewStreamChunk`, and `previewWebSocketData` each use their own sequence fields to make transport replay and ordering explicit.
- The relay persists session history separately; protocol version 1 does not define an ack/replay/WAL handshake between daemon and relay.
- Frame validation happens before unmarshal via `EnvelopeLimits`, which caps frame size, JSON depth, object field count, and array length.

In other words: the protocol streams data immediately, but durability is the relay's job, not the daemon wire contract's job.

## 6. Versioning + compat strategy

The repository uses a document-level protocol version (`1`) rather than per-message schema versions.

Compat strategy observed in the code and tests:

- Additive JSON fields are ignored by decoders.
- Unknown `type` values fail parsing.
- Missing optional fields stay omitted on the wire.
- `hello.capabilities` is the negotiation point for optional features such as terminals, preview tunneling, local server detection, context refs, and skills.
- The Go package mirrors `PROTOCOL.md`; changes are expected to be kept in lockstep.

Practical implication: breaking shape changes should be avoided. If they are unavoidable, they need a protocol version bump plus coordinated daemon/relay/client rollout.

## 7. Auth / identity in the protocol

The protocol does not carry a standalone auth subsystem. Identity and authorization are expressed through scoped identifiers and a few capability-like fields:

- `machineId` identifies the daemon host.
- `sessionId` identifies the chat/session boundary.
- `channelId` identifies the browser tab or client channel.
- `taskId`, `attemptId`, and `requestId` correlate work units and replies.
- `terminalId`, `previewId`, `streamId`, and `jobId` scope live subchannels.
- `token` in `terminalOpen` is the only explicit bearer-like field in this repo's wire surface.
- `expiresAt` on `previewOpen` bounds preview ownership in time.
- `traceparent` is W3C trace context, not auth.
- `claudeSessionId` is a resume handle for the runtime, not a credential.

Authorization itself is mostly enforced by the relay/daemon handlers, not by typed claims in the envelope.

## 8. Comparison to codex-peers MCP tool surface

Nearest tool names come from the current codex-peers MCP surface in this workspace (`spawn_peer`, `spawn_peer_and_wait`, `wait_for_peer`, `list_peers`, `peer_status`, `read_peer_log`, `send_peer_reply`, `spawn_gsd_phase_batch`, `integrate_peer`, `kill_peer`).

| GSD verb / family | Nearest codex-peers MCP tool | Gap |
|---|---|---|
| `task` | `spawn_peer` / `spawn_peer_and_wait` | MCP spawns agents, but does not speak the GSD task envelope or stream schema. |
| `stop` | `kill_peer` | No session-scoped interruption verb; kill is coarser than GSD cancellation. |
| `permissionResponse`, `questionResponse` | `send_peer_reply`, `request_user_input` | MCP can answer orchestrator prompts, but not GSD tool approvals or session questions in-band. |
| `compactRequest`, `contextStatsRequest` | none | No equivalent compaction or context-stat query tool. |
| `browseDir`, `readFile`, `mkDir`, `listSkills` | none | MCP surface has no daemon filesystem / skill discovery RPCs. |
| `stream`, `taskLifecycle`, `taskStarted`, `taskComplete`, `taskError`, `taskCancelled` | `read_peer_log`, `wait_for_peer` | MCP exposes agent status/logs, but not live task stream events. |
| `permissionRequest`, `question` | `request_user_input` | MCP can ask the user, but not with the GSD request IDs or structured tool-request semantics. |
| `hello`, `welcome`, `heartbeat`, `machineStatus` | none | No daemon handshake or machine presence channel. |
| `preview*` | none | No preview tunnel or loopback proxy surface. |
| `terminal*` | none | No PTY transport in the MCP surface. |
| `agentTerminal*` | none | No daemon-owned attachable terminal job abstraction. |
| `localServerDetected` | `read_peer_log` | Closest only by observation; no direct detection event. |

The gap is structural, not just naming. GSD is a transport protocol; the MCP surface is an orchestrator API.

## 9. Alignment options

| Option | Approx LOC | Pros | Cons | Recommendation |
|---|---:|---|---|---|
| (a) Adopt GSD verbatim and write a Go server impl | 1,500-3,500 | Maximum wire compatibility; easiest long-term interop with GSD clients and relays; clearer mapping to the source protocol. | Highest implementation and test burden; requires new transport/server surfaces, preview/terminal plumbing, and full protocol parity. | Best only if strict GSD compatibility is a hard requirement now. |
| (b) Wrap the existing MCP server with a thin GSD adapter | 600-1,200 | Lowest-risk path that preserves the current MCP internals; can expose the most important GSD verbs without rewriting the daemon. | Adapter semantics can leak; only a subset maps cleanly; some protocol features remain emulated or unsupported. | Best default choice. |
| (c) Define our own protocol inspired by, but not compatible with, GSD | 300-800 | Fastest path if we only need internal orchestration; simplest conceptual model for codex-peers. | Zero interoperability with GSD clients; creates future migration cost if compatibility becomes required. | Accept only if we explicitly do not need GSD wire compatibility. |

## 10. Recommendation

Recommend **(b) wrap the existing MCP server with a thin GSD adapter**.

Rationale:

- The current codex-peers surface already behaves like an orchestration API, not a wire protocol.
- GSD compatibility is valuable, but full verbatim parity would force a much larger rewrite than we need to prove out the daemon.
- An adapter keeps the current implementation leverage while letting us preserve GSD-shaped envelopes, IDs, and feature negotiation where it matters.
- If later requirements demand full protocol parity, the adapter can be hardened incrementally toward option (a) without throwing away the existing MCP work.

## Sources

- [PROTOCOL.md](https://github.com/gsd-build/protocol-go/blob/main/PROTOCOL.md)
- [messages.go](https://github.com/gsd-build/protocol-go/blob/main/messages.go)
- [envelope.go](https://github.com/gsd-build/protocol-go/blob/main/envelope.go)
- [binding.go](https://github.com/gsd-build/protocol-go/blob/main/binding.go)
- [limits.go](https://github.com/gsd-build/protocol-go/blob/main/limits.go)
- [README.md](https://github.com/gsd-build/protocol-go/blob/main/README.md)
- [messages_test.go](https://github.com/gsd-build/protocol-go/blob/main/messages_test.go)
- [hardening_test.go](https://github.com/gsd-build/protocol-go/blob/main/hardening_test.go)
- [LICENSE](https://github.com/gsd-build/protocol-go/blob/main/LICENSE)
