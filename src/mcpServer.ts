import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  killPeer,
  listPeers,
  peerStatus,
  readPeerLog,
  resumePeer,
  sendPeerMessage,
  spawnGsdPhaseBatch,
  spawnPeer,
  spawnPeerAndWait,
  waitForPeer,
} from "./peerManager.js";
import { expandSelectedPhases } from "./gsdPhaseList.js";
import { inspectGsdMilestone } from "./gsdMilestone.js";
import { integratePeer, IntegratePeerRefusedError } from "./peerIntegration.js";
import { classifyFrozenBatch } from "./frozen-eligibility/index.js";
import { readPeerInbox } from "./peerInbox.js";
import { listWorkflows, resumeWorkflowRun, spawnWorkflowRun, spawnWorkflowRunner, workflowEvents, workflowStatus } from "./workflow/manager.js";
import { validateWorkflowSource } from "./workflow/sandbox.js";
import { workflowsDir } from "./paths.js";
import type { SpawnSizingArgs, TaskScope } from "./taskSizing.js";
import type { GsdPlanningMode } from "./types.js";

// S3 Tier 1 sizing args — shared by spawn_peer and spawn_peer_and_wait. Optional
// and backward-compatible: omitting `scope` warns only on prompt length.
const SIZING_SCHEMA_PROPS = {
  scope: {
    type: "object" as const,
    description: "Declared blast radius for the task-sizing guardrail (warn-only). Absent = unknown.",
    properties: {
      files: { type: "number" as const, description: "Estimated number of files the peer will EDIT." },
      packages: { type: "number" as const, description: "Number of package/dir clusters touched (>1 = cross-package)." },
      downstream: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Cross-package consumer files/fixtures to update when a shared contract/type changes.",
      },
    },
  },
  size_override: {
    type: "boolean" as const,
    description: "Suppress the sizing warning for a deliberately large task (logged on lastEvent, never silent).",
  },
} as const;

// Codex peer tuning knobs (reasoning_effort, developer_instructions, codex_config).
// Declared before TOOLS since its schema literals reference them at module load.
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type ReasoningEffortValue = (typeof REASONING_EFFORTS)[number];

export const DEVELOPER_INSTRUCTIONS_MAX = 32_768; // codex's own project_doc default bound
export const CODEX_CONFIG_MAX_ENTRIES = 16;
export const CODEX_CONFIG_MAX_ENTRY_LEN = 2000;
export const CODEX_CONFIG_ENTRY_RE = /^[A-Za-z0-9_.-]+=.+$/s;

export const TOOLS = [
  {
    name: "spawn_peer",
    description:
      "Spawn a supervised headless peer (Codex by default, or Cursor when engine='cursor') in an isolated linked worktree. On success the peer pushes its own branch to origin (syncing the latest base first); it NEVER advances main/master directly. Use integrate_peer to open a pull request from that branch into the target branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute or relative path to a Git repository with origin." },
        prompt: { type: "string", description: "Task prompt for the peer." },
        name: { type: "string", description: "Optional display name for the peer." },
        start_ref: { type: "string", description: "Optional git ref used to create the peer worktree, such as origin/main, a local branch, HEAD, or a commit SHA." },
        startRef: { type: "string", description: "CamelCase alias for start_ref." },
        merge_branch: { type: "string", description: "Optional origin branch that receives successful peer changes. Defaults to the origin default branch, main, or master." },
        mergeBranch: { type: "string", description: "CamelCase alias for merge_branch." },
        target_branch: { type: "string", description: "Legacy alias. If newer fields are omitted, use this origin branch as both the start branch and merge branch." },
        targetBranch: { type: "string", description: "CamelCase alias for target_branch." },
        model: {
          type: "string",
          description:
            "Optional model override. For codex: any Codex model id. For cursor: composer-2-fast (default), sonnet, opus, gpt/codex, grok, gemini, or any cursor-agent model id.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Optional Codex sandbox mode (codex engine only).",
        },
        yolo: {
          type: "boolean",
          description: "Codex engine only: run with --dangerously-bypass-approvals-and-sandbox.",
        },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Codex engine only.",
        },
        engine: {
          type: "string",
          enum: ["codex", "cursor"],
          description: "Which CLI to drive the peer. Defaults to 'codex'. 'cursor' shells out to cursor-agent (uses your Cursor work seat for billing).",
        },
        cursor_options: {
          type: "object",
          description: "Cursor-engine-only options. Ignored when engine != 'cursor'.",
          properties: {
            cloud: { type: "boolean", description: "Run the peer on Cursor's cloud infra (--cloud). Does not consume local CPU." },
            approve_mcps: { type: "boolean", description: "Auto-approve MCP servers (--approve-mcps), e.g. for chrome-devtools browser MCP." },
            force: { type: "boolean", description: "Pass --force (default true). Set false to require manual file-edit approvals." },
          },
        },
        reasoning_effort: {
          type: "string",
          enum: REASONING_EFFORTS,
          description:
            "Codex engine only. Overrides Codex's model_reasoning_effort for any model (including gpt-5.5). Omit to keep today's default (high, except gpt-5.5).",
        },
        developer_instructions: {
          type: "string",
          maxLength: DEVELOPER_INSTRUCTIONS_MAX,
          description:
            `Codex engine only. Extra developer_instructions passed via -c (max ${DEVELOPER_INSTRUCTIONS_MAX} chars, codex's own project_doc bound).`,
        },
        codex_config: {
          type: "array",
          items: { type: "string" },
          maxItems: CODEX_CONFIG_MAX_ENTRIES,
          description:
            `Codex engine only. Extra 'key=value' pairs passed as -c flags after delamain's own, in order (so these win on conflict). Each entry must match ${CODEX_CONFIG_ENTRY_RE.source}, max ${CODEX_CONFIG_MAX_ENTRIES} entries, max ${CODEX_CONFIG_MAX_ENTRY_LEN} chars each.`,
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional peer ids (or id prefixes) whose work must merge first. Persisted as merge-order dependencies; integrate_peer refuses until every listed peer is merged.",
        },
        claims: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional repo-relative path prefixes this peer will edit, ':ro' suffix for read-only (e.g. src/api or docs:ro). Spawn is refused when a write claim overlaps an active peer's claims (fail-closed; no override via MCP).",
        },
        ...SIZING_SCHEMA_PROPS,
      },
      required: ["repo", "prompt"],
    },
  },
  {
    name: "list_peers",
    description: "List all known peers and their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_for_peer",
    description:
      "Block until an existing peer reaches a terminal status, or until timeout_ms elapses.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "Peer id or id prefix." },
        timeout_ms: {
          type: "number",
          description: "Maximum time to wait. Defaults to 30 minutes.",
        },
        poll_interval_ms: {
          type: "number",
          description: "Status polling interval. Defaults to 2000.",
        },
        log_lines: {
          type: "number",
          description: "Recent log lines to include in the result. Defaults to 80; use 0 to omit.",
        },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "peer_status",
    description: "Get a single peer status by id or id prefix.",
    inputSchema: {
      type: "object",
      properties: { peer_id: { type: "string" } },
      required: ["peer_id"],
    },
  },
  {
    name: "read_peer_log",
    description: "Read recent log lines for a peer.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        lines: { type: "number", description: "Number of recent lines to return." },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "send_peer_reply",
    description: "Resume a peer's Codex thread with a reply from the orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string" },
        yolo: { type: "boolean" },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
      },
      required: ["peer_id", "prompt"],
    },
  },
  {
    name: "send_peer_message",
    description:
      "Send a peer-to-peer message: enqueue a freeform-prose message into the recipient peer's inbox. Delivery is turn-boundary only — the recipient sees it when it next reaches a boundary (not mid-task). Set expect_reply to open a reply thread (mints a response_id the recipient echoes to close it); pass response_id to continue/close an existing thread. Returns { response_id }.",
    inputSchema: {
      type: "object",
      properties: {
        from_peer_id: { type: "string", description: "Sender peer id (id or prefix)." },
        to_peer_id: { type: "string", description: "Recipient peer id (id or prefix)." },
        message: { type: "string", description: "Freeform message body." },
        expect_reply: { type: "boolean", description: "Open a reply thread and mint a response_id when true." },
        response_id: { type: "string", description: "Existing thread id to continue or close (echo to close)." },
      },
      required: ["from_peer_id", "to_peer_id", "message"],
    },
  },
  {
    name: "read_peer_inbox",
    description:
      "Read a peer's inbox: queued peer-to-peer messages plus liveness notices about the senders (errored / awaiting-input / turn-ended / quiet / receiver-cancelled). Undelivered only by default; include_delivered returns full history.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "Inbox owner peer id (id or prefix)." },
        include_delivered: { type: "boolean", description: "Include already-delivered messages. Defaults to false." },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "spawn_peer_and_wait",
    description:
      "Spawn a supervised headless peer (Codex by default, or Cursor when engine='cursor') in an isolated linked worktree, then block until it reaches a terminal status or timeout_ms elapses.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute or relative path to a Git repository with origin." },
        prompt: { type: "string", description: "Task prompt for the peer." },
        name: { type: "string", description: "Optional display name for the peer." },
        start_ref: { type: "string", description: "Optional git ref used to create the peer worktree, such as origin/main, a local branch, HEAD, or a commit SHA." },
        startRef: { type: "string", description: "CamelCase alias for start_ref." },
        merge_branch: { type: "string", description: "Optional origin branch that receives successful peer changes. Defaults to the origin default branch, main, or master." },
        mergeBranch: { type: "string", description: "CamelCase alias for merge_branch." },
        target_branch: { type: "string", description: "Legacy alias. If newer fields are omitted, use this origin branch as both the start branch and merge branch." },
        targetBranch: { type: "string", description: "CamelCase alias for target_branch." },
        model: { type: "string", description: "Optional model override (see spawn_peer)." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Optional Codex sandbox mode (codex engine only).",
        },
        yolo: {
          type: "boolean",
          description: "Codex engine only: run with --dangerously-bypass-approvals-and-sandbox.",
        },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Codex engine only.",
        },
        engine: {
          type: "string",
          enum: ["codex", "cursor"],
          description: "Which CLI to drive the peer. Defaults to 'codex'.",
        },
        cursor_options: {
          type: "object",
          description: "Cursor-engine-only options. Ignored when engine != 'cursor'.",
          properties: {
            cloud: { type: "boolean" },
            approve_mcps: { type: "boolean" },
            force: { type: "boolean" },
          },
        },
        reasoning_effort: {
          type: "string",
          enum: REASONING_EFFORTS,
          description: "Codex engine only. See spawn_peer.",
        },
        developer_instructions: {
          type: "string",
          maxLength: DEVELOPER_INSTRUCTIONS_MAX,
          description: "Codex engine only. See spawn_peer.",
        },
        codex_config: {
          type: "array",
          items: { type: "string" },
          maxItems: CODEX_CONFIG_MAX_ENTRIES,
          description: "Codex engine only. See spawn_peer.",
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional peer ids (or id prefixes) whose work must merge first. Persisted as merge-order dependencies; integrate_peer refuses until every listed peer is merged.",
        },
        claims: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional repo-relative path prefixes this peer will edit, ':ro' suffix for read-only (e.g. src/api or docs:ro). Spawn is refused when a write claim overlaps an active peer's claims (fail-closed; no override via MCP).",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum time to wait. Defaults to 30 minutes.",
        },
        poll_interval_ms: {
          type: "number",
          description: "Status polling interval. Defaults to 2000.",
        },
        log_lines: {
          type: "number",
          description: "Recent log lines to include in the result. Defaults to 80; use 0 to omit.",
        },
        ...SIZING_SCHEMA_PROPS,
      },
      required: ["repo", "prompt"],
    },
  },
  {
    name: "kill_peer",
    description: "Kill a peer runner and its Codex process.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        signal: { type: "string", description: "SIGTERM or SIGKILL. Defaults to SIGTERM." },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "spawn_gsd_phase_batch",
    description:
      "Spawn a peer that drives /gsd-autonomous (dynamic mode) or /gsd-execute-phase (frozen mode) one phase at a time inside Codex CLI. Phase 33 plan 01 creates the spawn record only; the runner (plans 33-02/03) picks gsd_pending peers off the queue. Does NOT auto-push; use integrate_peer to push the branch and open a PR.",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description: "Absolute or relative path to a Git repository with origin, or a git URL.",
        },
        planning_mode: {
          type: "string",
          enum: ["dynamic", "frozen"],
          description: "GSD planning mode: dynamic (re-plan per phase via /gsd-autonomous) or frozen (execute frozen plan via /gsd-execute-phase).",
        },
        selected_phases: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "Phase IDs (NN-slug or NN.M-slug) and/or from..to ranges. Ranges require a known phase list — pass exact IDs here in plan 33-01.",
        },
        branch_name: { type: "string", description: "Optional branch for the runner-provisioned worktree (plan 33-02)." },
        milestone: { type: "string", description: "Informational milestone tag." },
        name: { type: "string", description: "Optional display name for the peer." },
        model: { type: "string", description: "Optional Codex model override for the runner." },
        reasoning_effort: {
          type: "string",
          enum: REASONING_EFFORTS,
          description: "Overrides Codex's model_reasoning_effort for any model. Omit to keep today's default (high, except gpt-5.5). See spawn_peer.",
        },
      },
      required: ["repo_url", "planning_mode", "selected_phases"],
    },
  },
  {
    name: "inspect_gsd_milestone",
    description:
      "Clone the repo to a temp dir, read .planning/, and return an ordered phase list with per-phase readiness flags (has_context, has_plan, has_frozen_contract, has_verification, has_summary). Read-only; cleans up the temp clone. Use before spawn_gsd_phase_batch to confirm phases are runnable.",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          minLength: 1,
          description: "Absolute or relative local path to a Git repository, or a git URL.",
        },
        branch: {
          type: "string",
          description: "Optional branch to check out before reading .planning/. Defaults to origin's HEAD.",
        },
        milestone_filter: {
          type: "string",
          description: "Optional substring; only phase IDs containing this substring are returned.",
        },
      },
      required: ["repo_url"],
    },
  },
  {
    name: "run_workflow",
    description:
      "Run a code-defined workflow script (export const meta + export default async run(ctx)) in the sandboxed workflow engine. The script's only capability is ctx: ctx.agent(prompt, {schema, model, label}) spawns ONE codex leaf peer in a throwaway worktree with integrate:false and returns its (optionally JSON-Schema-validated) result; ctx.log(msg) writes to the run log. Returns { workflow_id } immediately; poll workflow_status. The run terminates on script return (status done) or on timeout_ms (status halted).",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Inline workflow script source (TS/JS module). Provide this or script_path." },
        script_path: { type: "string", description: "Path to a workflow script file. Provide this or script." },
        repo: { type: "string", description: "Repository the workflow's agents run against. Defaults to the server's cwd." },
        timeout_ms: { type: "number", description: "Wall-clock termination guard; the run is halted (child + leaf peers killed) when exceeded." },
        max_agents: { type: "number", description: "Hard cap on total leaf agents spawned over the run; exceeding it halts the run." },
        budget_tokens: { type: "number", description: "Cumulative leaf-token budget; exhausting it halts the run." },
        name: { type: "string", description: "Optional display name for the workflow run." },
        resume: { type: "string", description: "Resume an existing workflow id: replay its journaled agent prefix and run only the remainder live (ignores script/script_path)." },
      },
    },
  },
  {
    name: "workflow_status",
    description: "Get a workflow run's status: workflow-level status (pending/running/done/failed/halted), result, error, and spawned agent peer ids.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow id (or id prefix) returned by run_workflow." },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "list_workflows",
    description: "List all workflow runs (kind=workflow_run) with their workflow-level status, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "workflow_events",
    description: "Read a workflow's lifecycle event stream (workflow_start/phase_start/agent_spawn/agent_done/agent_failed/workflow_end), oldest first. Pass `since` (a seq) to tail only newer events.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow id (or id prefix)." },
        since: { type: "number", description: "Return only events with seq greater than this. Defaults to 0 (all)." },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "integrate_peer",
    description:
      "Integrate a completed peer via pull request: commit and push the peer's own branch to origin, then open a PR into the target branch (main/master by default) and enable GitHub auto-merge so it lands once checks pass. Never advances the target branch directly. Refuses peers in running/halted/failed states. Requires gh authenticated for the repo's owner. Returns pr_number/pr_url/auto_merge_enabled.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string", minLength: 1, description: "Peer id or id prefix." },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "classify_frozen_batch",
    description:
      "Conservative pre-flight eligibility check for a planning_mode=frozen PhaseBatch. " +
      "Returns { eligible: true } only when every selected phase has a FROZEN-CONTRACT.json, " +
      "every PLAN.md frontmatter declares type: execute AND autonomous: true, and no " +
      "risky keywords (TODO, FIXME, WIP, scratch, discussion needed, needs human review) " +
      "appear in CONTEXT/SPEC/PLAN files. Otherwise returns { eligible: false, reasons: string[] } " +
      "listing EVERY failing condition (no short-circuit) so the UI can render a complete " +
      "blocker list. Mirror of the DevOS Tauri command `dispatch_classify_frozen_batch` " +
      "(Phase 37 plan 02).",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Absolute filesystem path to the repository root (where .planning/ lives). " +
            "For delamain usage this is typically a peer worktree path.",
        },
        phase_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Selected phase IDs (directory names under .planning/phases/). " +
            "Same shape as `selected_phases` from spawn_gsd_phase_batch.",
        },
      },
      required: ["repo", "phase_ids"],
    },
  },
];

export async function startMcpServer(): Promise<void> {
  const transport = new StdioJsonRpcTransport(async (request) => {
    try {
      const result = await handleRequest(request);
      if (request.id !== undefined && result !== undefined) {
        transport.send({ jsonrpc: "2.0", id: request.id, result });
      }
    } catch (error) {
      if (request.id !== undefined) {
        transport.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  });
  transport.start();
}

async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "delamain",
          title: "Delamain — multi-engine peer supervisor",
          version: "0.1.0",
        },
        instructions:
          "Use this MCP server (delamain) to spawn and supervise headless coding peers — Codex or Cursor — across repositories. New peers run in isolated linked worktrees. By default they start from the origin default branch and merge successful changes back there; callers can choose a separate start_ref, merge_branch, and engine ('codex' or 'cursor'). Use list_peers and read_peer_log to monitor progress; use send_peer_reply when a peer reports CODEX_PEERS_STATUS: WAITING. For peer-to-peer messaging, use send_peer_message to enqueue a message into another peer's inbox (delivered at the recipient's next turn boundary) and read_peer_inbox to read queued messages plus sender-liveness notices.",
      };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(request.params?.name, request.params?.arguments || {});
    default:
      if (request.id === undefined) {
        return undefined;
      }
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

export async function callTool(name: unknown, rawArgs: unknown): Promise<unknown> {
  const args = (rawArgs || {}) as Record<string, unknown>;
  switch (name) {
    case "spawn_peer":
      return json(spawnPeer({
        repo: requiredString(args, "repo"),
        prompt: requiredString(args, "prompt"),
        name: optionalString(args, "name"),
        ...branchOptions(args),
        model: optionalString(args, "model"),
        sandbox: optionalString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
        engine: engineValue(args),
        cursorOptions: cursorOptionsValue(args),
        // No claimsOverride here on purpose — MCP-driven spawns stay fail-closed on claim conflicts.
        dependsOn: optionalStringArray(args, "depends_on", "dependsOn"),
        claims: optionalStringArray(args, "claims"),
        ...codexTuningOptions(args, engineValue(args)),
        ...sizingOptions(args),
      }));
    case "list_peers":
      return json(listPeers());
    case "wait_for_peer":
      return json(await waitForPeer({
        peerId: requiredString(args, "peer_id"),
        ...waitOptions(args),
      }));
    case "peer_status":
      return json(peerStatus(requiredString(args, "peer_id")));
    case "read_peer_log":
      return text(readPeerLog(requiredString(args, "peer_id"), optionalNumber(args, "lines") || 120));
    case "send_peer_reply":
      return json(resumePeer({
        peerId: requiredString(args, "peer_id"),
        prompt: requiredString(args, "prompt"),
        model: optionalString(args, "model"),
        yolo: bypassEnabled(args),
      }));
    case "send_peer_message": {
      // Shared enqueue + immediate turn-boundary delivery attempt; queued
      // messages are picked up by the runner-exit drain at the next boundary.
      const { responseId, delivery } = sendPeerMessage({
        fromPeerId: requiredString(args, "from_peer_id"),
        toPeerId: requiredString(args, "to_peer_id"),
        message: requiredString(args, "message"),
        expectReply: args.expect_reply === true,
        responseId: optionalString(args, "response_id"),
      });
      return json({ response_id: responseId ?? null, delivery });
    }
    case "read_peer_inbox":
      return json(readPeerInbox(requiredString(args, "peer_id"), {
        includeDelivered: args.include_delivered === true,
      }));
    case "spawn_peer_and_wait":
      return json(await spawnPeerAndWait({
        repo: requiredString(args, "repo"),
        prompt: requiredString(args, "prompt"),
        name: optionalString(args, "name"),
        ...branchOptions(args),
        model: optionalString(args, "model"),
        sandbox: optionalString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
        engine: engineValue(args),
        cursorOptions: cursorOptionsValue(args),
        // No claimsOverride here on purpose — MCP-driven spawns stay fail-closed on claim conflicts.
        dependsOn: optionalStringArray(args, "depends_on", "dependsOn"),
        claims: optionalStringArray(args, "claims"),
        ...codexTuningOptions(args, engineValue(args)),
        ...sizingOptions(args),
        ...waitOptions(args),
      }));
    case "kill_peer":
      return json(killPeer(requiredString(args, "peer_id"), signalValue(args.signal)));
    case "spawn_gsd_phase_batch": {
      const repo = requiredString(args, "repo_url");
      const planningMode = requiredEnum(args, "planning_mode", ["dynamic", "frozen"]) as GsdPlanningMode;
      const rawSelected = args.selected_phases;
      if (!Array.isArray(rawSelected) || rawSelected.length === 0) {
        throw new Error("spawn_gsd_phase_batch: 'selected_phases' must be a non-empty array");
      }
      for (const entry of rawSelected) {
        if (typeof entry !== "string") {
          throw new Error("spawn_gsd_phase_batch: 'selected_phases' entries must be strings");
        }
      }
      const expanded = expandSelectedPhases(rawSelected as string[]);
      const peer = spawnGsdPhaseBatch({
        repo,
        name: optionalString(args, "name"),
        branch: optionalString(args, "branch_name") ?? optionalString(args, "branchName"),
        model: optionalString(args, "model"),
        reasoningEffort: reasoningEffortValue(args),
        gsdBatch: {
          planning_mode: planningMode,
          selected_phases: expanded,
          milestone: optionalString(args, "milestone"),
          cursor: 0,
        },
      });
      return json({
        peer_id: peer.id,
        status: peer.status,
        kind: peer.kind,
        gsd_batch: peer.gsdBatch,
      });
    }
    case "inspect_gsd_milestone": {
      const result = await inspectGsdMilestone({
        repo_url: requiredString(args, "repo_url"),
        branch: optionalString(args, "branch"),
        milestone_filter: optionalString(args, "milestone_filter"),
      });
      return json(result);
    }
    case "classify_frozen_batch": {
      const repo = requiredString(args, "repo");
      const phaseIdsRaw = (args as Record<string, unknown>)["phase_ids"];
      if (!Array.isArray(phaseIdsRaw)) {
        throw new Error("classify_frozen_batch: 'phase_ids' must be an array of strings");
      }
      for (const entry of phaseIdsRaw) {
        if (typeof entry !== "string") {
          throw new Error("classify_frozen_batch: 'phase_ids' entries must be strings");
        }
      }
      const result = await classifyFrozenBatch(repo, phaseIdsRaw as string[]);
      return json(result);
    }
    case "run_workflow": {
      const resumeId = optionalString(args, "resume");
      if (resumeId) {
        const resumed = resumeWorkflowRun(resumeId);
        return json({ workflow_id: resumed.id, status: resumed.status, resumed: true, workflow: resumed.workflow });
      }
      const inlineScript = optionalString(args, "script");
      let scriptPath = optionalString(args, "script_path") ?? optionalString(args, "scriptPath");
      if (!inlineScript && !scriptPath) {
        throw new Error("run_workflow requires either 'script' (inline source) or 'script_path'");
      }
      if (inlineScript && scriptPath) {
        throw new Error("run_workflow accepts 'script' or 'script_path', not both");
      }
      if (inlineScript) {
        validateWorkflowSource(inlineScript, "inline-script");
        mkdirSync(workflowsDir(), { recursive: true });
        scriptPath = join(workflowsDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.ts`);
        writeFileSync(scriptPath, inlineScript, "utf8");
      } else {
        validateWorkflowSource(readFileSync(scriptPath as string, "utf8"), scriptPath);
      }
      const run = spawnWorkflowRun({
        repo: optionalString(args, "repo") ?? process.cwd(),
        scriptPath: scriptPath as string,
        timeoutMs: optionalNumber(args, "timeout_ms") ?? optionalNumber(args, "timeoutMs"),
        maxAgents: optionalNumber(args, "max_agents") ?? optionalNumber(args, "maxAgents"),
        budgetTokens: optionalNumber(args, "budget_tokens") ?? optionalNumber(args, "budgetTokens"),
        name: optionalString(args, "name"),
      });
      spawnWorkflowRunner(run.id);
      return json({ workflow_id: run.id, status: run.status, workflow: run.workflow });
    }
    case "list_workflows":
      return json(
        listWorkflows().map((p) => ({
          workflow_id: p.id,
          name: p.name ?? null,
          status: p.status,
          workflow_status: p.workflow?.status ?? null,
          agent_count: p.workflow?.agentPeerIds?.length ?? 0,
          replayed_agents: p.workflow?.replayedAgents ?? 0,
          tokens_spent: p.workflow?.tokensSpent ?? 0,
          started_at: p.startedAt,
          finished_at: p.finishedAt ?? null,
        })),
      );
    case "workflow_events": {
      const wf = workflowStatus(requiredString(args, "workflow_id"));
      const since = optionalNumber(args, "since") ?? 0;
      return json({ workflow_id: wf.id, events: workflowEvents(wf.id, since) });
    }
    case "workflow_status": {
      const peer = workflowStatus(requiredString(args, "workflow_id"));
      return json({
        workflow_id: peer.id,
        status: peer.status,
        workflow: peer.workflow,
        error: peer.error ?? null,
        last_event: peer.lastEvent ?? null,
        runner_pid: peer.runnerPid ?? null,
      });
    }
    case "integrate_peer": {
      try {
        const r = await integratePeer(requiredString(args, "peer_id"));
        return json({
          peer_id: r.peer.id,
          status: r.peer.status,
          integration: r.outcome,
        });
      } catch (err) {
        if (err instanceof IntegratePeerRefusedError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    refused: true,
                    peer_id: err.peerId,
                    status: err.status,
                    message: err.message,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
    default:
      throw new Error(`Unknown tool: ${String(name)}`);
  }
}

function json(value: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function text(value: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: value }],
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function requiredEnum(args: Record<string, unknown>, key: string, allowed: readonly string[]): string {
  const value = requiredString(args, key);
  if (!allowed.includes(value)) {
    throw new Error(`Invalid value for ${key}: ${value}. Expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string, alias?: string): string[] | undefined {
  const raw = args[key] ?? (alias ? args[alias] : undefined);
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return raw as string[];
}

function waitOptions(args: Record<string, unknown>): {
  timeoutMs?: number;
  pollIntervalMs?: number;
  logLines?: number;
} {
  return {
    timeoutMs: optionalNumber(args, "timeout_ms") ?? optionalNumber(args, "timeoutMs"),
    pollIntervalMs: optionalNumber(args, "poll_interval_ms") ?? optionalNumber(args, "pollIntervalMs"),
    logLines: optionalNumber(args, "log_lines") ?? optionalNumber(args, "logLines"),
  };
}

function branchOptions(args: Record<string, unknown>): {
  startRef?: string;
  mergeBranch?: string;
  targetBranch?: string;
} {
  return {
    startRef: optionalString(args, "start_ref") ?? optionalString(args, "startRef"),
    mergeBranch: optionalString(args, "merge_branch") ?? optionalString(args, "mergeBranch"),
    targetBranch: optionalString(args, "target_branch") ?? optionalString(args, "targetBranch"),
  };
}

function sizingOptions(args: Record<string, unknown>): SpawnSizingArgs {
  const out: SpawnSizingArgs = {};
  const rawScope = args.scope;
  if (rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)) {
    const s = rawScope as Record<string, unknown>;
    const scope: TaskScope = {};
    if (typeof s.files === "number" && Number.isFinite(s.files)) scope.files = s.files;
    if (typeof s.packages === "number" && Number.isFinite(s.packages)) scope.packages = s.packages;
    if (Array.isArray(s.downstream)) scope.downstream = s.downstream.filter((x): x is string => typeof x === "string");
    if (Object.keys(scope).length > 0) out.scope = scope;
  }
  const override = args.size_override ?? args.sizeOverride;
  if (typeof override === "boolean") out.sizeOverride = override;
  return out;
}

function signalValue(value: unknown): NodeJS.Signals {
  return value === "SIGKILL" ? "SIGKILL" : "SIGTERM";
}

function bypassEnabled(args: Record<string, unknown>): boolean {
  return Boolean(
    args.yolo ||
      args.dangerously_bypass_approvals_and_sandbox ||
      args["dangerously-bypass-approvals-and-sandbox"],
  );
}

function engineValue(args: Record<string, unknown>): "codex" | "cursor" | undefined {
  const raw = args.engine;
  if (raw === "cursor" || raw === "codex") return raw;
  return undefined;
}

function cursorOptionsValue(
  args: Record<string, unknown>,
): { cloud?: boolean; approveMcps?: boolean; force?: boolean } | undefined {
  const raw = args.cursor_options ?? args.cursorOptions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: { cloud?: boolean; approveMcps?: boolean; force?: boolean } = {};
  if (typeof record.cloud === "boolean") out.cloud = record.cloud;
  const approveMcps = record.approve_mcps ?? record.approveMcps;
  if (typeof approveMcps === "boolean") out.approveMcps = approveMcps;
  if (typeof record.force === "boolean") out.force = record.force;
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- Codex peer tuning knobs (reasoning_effort, developer_instructions, codex_config) ---
// Validated at the MCP boundary: fail loud with a clear message rather than
// silently dropping or truncating a bad value.
// (Constants live near the top of the file — TOOLS's schema literals below
// reference them and are evaluated at module load, before this point.)

export function reasoningEffortValue(args: Record<string, unknown>): ReasoningEffortValue | undefined {
  const raw = args.reasoning_effort ?? args.reasoningEffort;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid reasoning_effort: ${JSON.stringify(raw)}. Expected one of: ${REASONING_EFFORTS.join(", ")}`);
  }
  return raw as ReasoningEffortValue;
}

export function developerInstructionsValue(args: Record<string, unknown>): string | undefined {
  const raw = args.developer_instructions ?? args.developerInstructions;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error("developer_instructions must be a string");
  }
  if (raw.length > DEVELOPER_INSTRUCTIONS_MAX) {
    throw new Error(`developer_instructions exceeds ${DEVELOPER_INSTRUCTIONS_MAX} chars (got ${raw.length})`);
  }
  return raw;
}

export function codexConfigValue(args: Record<string, unknown>): string[] | undefined {
  const raw = args.codex_config ?? args.codexConfig;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("codex_config must be an array of 'key=value' strings");
  }
  if (raw.length > CODEX_CONFIG_MAX_ENTRIES) {
    throw new Error(`codex_config has ${raw.length} entries; max ${CODEX_CONFIG_MAX_ENTRIES}`);
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length > CODEX_CONFIG_MAX_ENTRY_LEN || !CODEX_CONFIG_ENTRY_RE.test(entry)) {
      throw new Error(
        `codex_config entry invalid (must match key=value, <=${CODEX_CONFIG_MAX_ENTRY_LEN} chars): ${JSON.stringify(entry)}`,
      );
    }
  }
  return raw as string[];
}

export function codexTuningOptions(
  args: Record<string, unknown>,
  engine: "codex" | "cursor" | undefined,
): { reasoningEffort?: ReasoningEffortValue; developerInstructions?: string; codexConfig?: string[] } {
  const reasoningEffort = reasoningEffortValue(args);
  const developerInstructions = developerInstructionsValue(args);
  const codexConfig = codexConfigValue(args);
  if (engine === "cursor" && (reasoningEffort !== undefined || developerInstructions !== undefined || codexConfig !== undefined)) {
    throw new Error(
      "reasoning_effort, developer_instructions, and codex_config are codex-engine-only; do not pass them with engine='cursor'",
    );
  }
  return { reasoningEffort, developerInstructions, codexConfig };
}

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

class StdioJsonRpcTransport {
  private buffer = "";
  private mode: "line" | "headers" | undefined;

  constructor(private readonly onRequest: (request: JsonRpcRequest) => Promise<void>) {}

  start(): void {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
    process.stdin.resume();
  }

  send(response: JsonRpcResponse): void {
    const body = JSON.stringify(response);
    if (this.mode === "headers") {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    } else {
      process.stdout.write(`${body}\n`);
    }
  }

  private drain(): void {
    if (!this.mode) {
      this.mode = this.buffer.startsWith("Content-Length:") ? "headers" : "line";
    }
    if (this.mode === "headers") {
      this.drainHeaders();
    } else {
      this.drainLines();
    }
  }

  private drainLines(): void {
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private drainHeaders(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd);
      const length = header
        .split(/\r\n/)
        .map((line) => line.match(/^Content-Length:\s*(\d+)$/i)?.[1])
        .find(Boolean);
      if (!length) {
        throw new Error("Invalid MCP message: missing Content-Length");
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(length);
      if (this.buffer.length < bodyStart + bodyLength) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyStart + bodyLength);
      this.buffer = this.buffer.slice(bodyStart + bodyLength);
      this.handleLine(body);
    }
  }

  private handleLine(line: string): void {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      console.error(`[delamain] invalid JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void this.onRequest(request);
  }
}
