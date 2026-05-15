# Cursor MCP Wrapper Comparison

Snapshot date: 2026-05-15. GitHub metadata below comes from `gh api` at that time.

## The three repos at a glance

| Repo | Stars | Push date | Lang | MCP tools exposed |
|---|---:|---|---|---|
| `GustavoWinter/cursor-agent-orchestrator-mcp` | 1 | 2026-05-12T02:21:28Z | TypeScript | `propose_plan`, `confirm_plan`, `execute_plan`, `stream_plan`, `get_plan_status`, `get_subagent_result`, `list_plans`, `cancel_plan`, `cancel_subagent`, `prompt_one_shot`, `prune_runs`, `attach_plan`, `resume_plan` |
| `ai-nuke/cursor-agent-mcp` | 0 | 2026-05-12T18:58:48Z | JavaScript | `health_check`, `list_models`, `model_capabilities`, `list_skills`, `handoff`, `start_task`, `list_jobs`, `job_status`, `tail_job`, `job_result`, `cancel_job` |
| `thsunkid/orchestrate-cursor-agent-mcp` | 2 | 2026-03-26T14:12:40Z | JavaScript | `cursor_agent_spawn`, `cursor_agent_check`, `cursor_agent_reply`, `cursor_agent_status`, `cursor_agent_result`, `cursor_agent_kill` |

Local baseline for this repo:

- [`src/mcpServer.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/mcpServer.ts#L18) exposes `spawn_peer`, `spawn_peer_and_wait`, `wait_for_peer`, `peer_status`, `read_peer_log`, `send_peer_reply`, `kill_peer`, `spawn_gsd_phase_batch`, `inspect_gsd_milestone`, and `integrate_peer`.
- [`src/cursorRunner.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/cursorRunner.ts#L68) is the cursor-engine runner behind `engine: "cursor"`, and [`src/peerManager.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/peerManager.ts#L28) owns spawn / wait / cancel.

## Tool surface comparison

| Repo | Spawn peer equivalent | Wait / stream | Cancel |
|---|---|---|---|
| Gustavo | `propose_plan` -> `execute_plan` drives stage-level fan-out, plus `prompt_one_shot` for one-off delegation | `stream_plan` is the primary live feed; `get_plan_status` and `get_subagent_result` are snapshots | `cancel_plan` and `cancel_subagent` |
| ai-nuke | `handoff` and `start_task` create persisted jobs | `job_status`, `tail_job`, and `job_result`; `tail_job` is byte-offset based, not event-based | `cancel_job` |
| thsunkid | `cursor_agent_spawn` starts one background cursor-agent session | `cursor_agent_check`, `cursor_agent_status`, `cursor_agent_result`, and a returned watcher command; bridge side waits on answer files | `cursor_agent_kill` |
| this repo | `spawn_peer` / `spawn_peer_and_wait` create isolated linked-worktree peers; `send_peer_reply` resumes a waiting peer | `wait_for_peer` polls state; `read_peer_log` gives tail access; cursor engine also parses `stream-json` output in-process | `kill_peer` |

The main asymmetry is that Gustavo and this repo both model an orchestrator supervising multiple workers, while ai-nuke models durable job execution, and thsunkid models a live back-and-forth bridge.

## Gustavo's propose/confirm/execute pattern

Mechanism:

- `propose_plan` is the front door. It requires a Cursor API key, can ask clarification questions instead of returning a plan, stores the plan, and renders a Mermaid diagram for the parent agent. Code pointer: [`src/tools/propose-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/propose-plan.ts#L10).
- `confirm_plan` is a separate explicit approval write. It records that the user approved the plan and is idempotent. It can be bypassed with `CURSOR_ORCH_SKIP_CONFIRMATION=true` in the MCP env. Code pointer: [`src/tools/confirm-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/confirm-plan.ts#L7).
- `execute_plan` refuses to run unless `approved: true` is present. If `planId` is used, it also requires prior confirmation unless confirmation was skipped. It can run only selected stages or selected subagents, and it supports `dryRun` so resolution can be validated without creating agents. Code pointer: [`src/tools/execute-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/execute-plan.ts#L10).
- The execution engine fans out per stage, not globally. Workers in a stage run in parallel, verifiers run after workers, and the executor publishes lifecycle events into a cursorable stream. Code pointers: [`src/orchestrator/execution/executor.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/executor.ts#L70), [`src/orchestrator/execution/stage-runner.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/stage-runner.ts#L82), [`src/orchestrator/execution/subagent-runner.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/subagent-runner.ts#L94).
- `stream_plan` is cursor-based rather than polling-based in the blunt sense. It uses an append-only event log with `sinceSequence` / `nextCursor` and blocks only until a new event appears or a timeout elapses. Code pointers: [`src/tools/stream-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/stream-plan.ts#L8), [`src/orchestrator/events/stream-mux.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/events/stream-mux.ts#L34).
- Text deltas are coalesced so the stream is readable instead of chatty. Code pointer: [`src/orchestrator/events/stream-coalesce.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/events/stream-coalesce.ts#L56).

Would this help our supervisor before YOLO-fanouts?

- Yes, but only at the fan-out boundary.
- The useful part is not the planner UI. The useful part is the explicit approval fence before a large batch of subagents is launched.
- For this repo, the natural place to borrow that pattern would be `spawn_gsd_phase_batch` or any future bulk peer launcher, not the ordinary single-peer `spawn_peer` path.
- I would not add the full plan/diagram workflow to every delegation path. That would add ceremony where we already have worktree isolation and a clear `spawn -> wait -> kill` lifecycle.

## ai-nuke's job-persistence + write-scope contracts

Exact mechanism:

- Every job gets persistent metadata before the process starts. `createJob()` writes a job JSON file, a prompt file, stdout and stderr files, an optional result JSON, and a provider log. The launcher then spawns a separate runner process that owns the job. Code pointers: [`bin/cursor-agent-mcp.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/cursor-agent-mcp.js#L523), [`bin/run-agent-job.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/run-agent-job.js#L1).
- `handoff` is the sync-friendly entry point. It creates a persisted job, then waits briefly for completion for read-only work; edit-mode jobs usually return immediately. `start_task` is the explicit background variant. Code pointer: [`bin/cursor-agent-mcp.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/cursor-agent-mcp.js#L1140).
- `job_status` reports elapsed time, stdout/stderr byte counts, expected-file checks, changed-file counts, and contract state. `tail_job` reads stdout or stderr by byte offset and returns `nextOffset`, so a caller can stream incrementally without re-reading the whole file. `job_result` returns the parsed final JSON plus log tails. Code pointer: [`bin/cursor-agent-mcp.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/cursor-agent-mcp.js#L836).
- The runner snapshots the workspace before execution, diffs after exit, checks expected files and required JSON fields, enforces allowed write roots, optionally runs post commands, and can remove newly added files on failure. Code pointer: [`bin/run-agent-job.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/run-agent-job.js#L360).
- Cancellation is process-tree based. `cancel_job` marks the job cancelled, kills the agent and runner, and releases the lock. Code pointer: [`bin/cursor-agent-mcp.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/cursor-agent-mcp.js#L1044).

What matters for us:

- This is stronger than a tail-by-log-line design. The byte-offset tail gives a stable incremental read contract.
- The write-scope contract is post-run enforcement, not a filesystem sandbox. That is still useful, but it should be understood as detection plus cleanup, not prevention.
- This pattern maps well to external cursor-agent jobs that may outlive the MCP call, especially if we want to prove which files were allowed to change.

## thsunkid's bidirectional MCP bridge

Exact mechanism:

- The orchestrator MCP starts a `cursor-agent` process with a prompt preamble that instructs the agent to communicate only via `report_to_orchestrator`. Code pointer: [`src/orchestrator-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/orchestrator-mcp/server.js#L154).
- The orchestrator discovers the bridge MCP directory by looking for a new `bridge-{pid}` directory after spawn. That bridge directory is stored in state so multiple sessions can coexist. Code pointer: [`src/orchestrator-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/orchestrator-mcp/server.js#L96).
- The bridge MCP exposes exactly one tool, `report_to_orchestrator`. It writes `question_<turn>.json`, then polls for `answer_<turn>.json`. If the answer appears, it returns the reply to cursor-agent and deletes the files. Code pointer: [`src/bridge-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/bridge-mcp/server.js#L71).
- The bridge sends MCP progress heartbeats every 30 seconds so the client timeout does not fire while it is polling. Code pointer: [`src/bridge-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/bridge-mcp/server.js#L110).
- The orchestrator CLI also exposes `spawn`, `check`, `reply`, `status`, `result`, and `kill` commands over the same file-based session. Code pointer: [`src/orchestrator.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/orchestrator.js#L100).
- The PostToolUse hook scans for unanswered question files and injects a reminder into additional context, which is a nice usability layer but not a separate transport. Code pointer: [`src/hooks/post-tool-use.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/hooks/post-tool-use.js#L28).

Does it eliminate polling?

- No.
- It removes the need for the supervising agent to poll cursor-agent directly, but the bridge still polls the filesystem for answer files, and the orchestrator still relies on a watcher command or follow-up check.
- So the improvement is architectural, not magical. The bidirectional loop is real, but it is still file-backed and timer-backed.

## Features worth porting

| Feature | Source repo | LOC estimate | Dependencies | Risk |
|---|---|---:|---|---|
| Explicit approval fence before bulk fan-out | Gustavo | 120-220 | Plan store, approval state, tool schema, prompt wording | Low to medium |
| Cursor-based event cursor with `nextCursor` / `sinceSequence` | Gustavo | 140-240 | Append-only event log, store replay, blocking wait primitive | Low |
| Output coalescing for noisy assistant deltas | Gustavo | 60-120 | Stream parsing, event publishing | Low |
| Persisted job metadata before launch | ai-nuke | 140-220 | Prompt files, stdout/stderr files, runner process, job store | Low |
| Byte-offset tail API for logs | ai-nuke | 80-140 | Stable per-job log files, file size/offset reads | Low |
| Write-scope contract checks and optional cleanup | ai-nuke | 180-320 | Workspace snapshotting, diffing, allowed-root resolution, cleanup logic | Medium |
| Reverse MCP bridge for agent-to-supervisor questions | thsunkid | 180-300 | Cursor-agent MCP support, file IPC, bridge install, watcher flow | High |

Estimates are for what would be needed in this repo, not copied LOC. The risk column is mostly about operational complexity and coupling, not implementation difficulty.

## Combined recommendation

- Adopt Gustavo's approval boundary for any future bulk launch path. It is the best way to make a large fan-out feel intentional instead of accidental.
- Borrow Gustavo's cursor-based streaming model if we want a real live board for long runs. Our current `wait_for_peer` is coarse polling, while the cursor repo already has the non-lossy event replay shape.
- Port ai-nuke's byte-offset tail and write-scope contract checks next. Those give the highest practical value for external cursor-agent jobs because they improve observability and make output contracts explicit.
- Skip thsunkid's reverse bridge as the default architecture. It is clever, but it adds another MCP process, another file protocol, and another polling loop. Only revisit it if we need the agent itself to ask questions mid-run in a way that `send_peer_reply` cannot cover.
- Keep this repo's current core: linked worktrees, `spawn_peer`, `wait_for_peer`, `kill_peer`, and the cursor-engine runner. The missing pieces are contract strength and streaming ergonomics, not a new way to launch processes.

## Sources

- GustavoWinter repo root: https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp
- [`src/tools/index.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/index.ts#L1)
- [`src/tools/propose-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/propose-plan.ts#L10)
- [`src/tools/confirm-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/confirm-plan.ts#L7)
- [`src/tools/execute-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/execute-plan.ts#L10)
- [`src/tools/stream-plan.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/stream-plan.ts#L8)
- [`src/tools/cancel.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/tools/cancel.ts#L7)
- [`src/orchestrator/events/stream-mux.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/events/stream-mux.ts#L34)
- [`src/orchestrator/events/stream-coalesce.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/events/stream-coalesce.ts#L56)
- [`src/orchestrator/execution/executor.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/executor.ts#L70)
- [`src/orchestrator/execution/stage-runner.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/stage-runner.ts#L82)
- [`src/orchestrator/execution/subagent-runner.ts`](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp/blob/main/src/orchestrator/execution/subagent-runner.ts#L94)
- ai-nuke repo root: https://github.com/ai-nuke/cursor-agent-mcp
- [`bin/cursor-agent-mcp.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/cursor-agent-mcp.js#L523)
- [`bin/run-agent-job.js`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/bin/run-agent-job.js#L1)
- [`README.md`](https://github.com/ai-nuke/cursor-agent-mcp/blob/main/README.md#L1)
- thsunkid repo root: https://github.com/thsunkid/orchestrate-cursor-agent-mcp
- [`src/orchestrator-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/orchestrator-mcp/server.js#L1)
- [`src/bridge-mcp/server.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/bridge-mcp/server.js#L1)
- [`src/orchestrator.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/orchestrator.js#L1)
- [`src/hooks/post-tool-use.js`](https://github.com/thsunkid/orchestrate-cursor-agent-mcp/blob/main/src/hooks/post-tool-use.js#L1)
- Local baseline: [`src/mcpServer.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/mcpServer.ts#L18)
- Local baseline: [`src/cursorRunner.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/cursorRunner.ts#L68)
- Local baseline: [`src/peerManager.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/aa60147d/src/peerManager.ts#L28)
