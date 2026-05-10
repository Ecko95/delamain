import {
  killPeer,
  listPeers,
  peerStatus,
  readPeerLog,
  resumePeer,
  spawnGsdPhaseBatch,
  spawnPeer,
  spawnPeerAndWait,
  waitForPeer,
} from "./peerManager.js";
import { expandSelectedPhases } from "./gsdPhaseList.js";
import { inspectGsdMilestone } from "./gsdMilestone.js";
import { integratePeer, IntegratePeerRefusedError } from "./peerIntegration.js";
import type { GsdPlanningMode } from "./types.js";

const TOOLS = [
  {
    name: "spawn_peer",
    description:
      "Spawn a supervised headless Codex peer in an isolated linked worktree, then integrate successful changes into the origin default branch or explicit target branch.",
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
        model: { type: "string", description: "Optional Codex model override." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Optional Codex sandbox mode.",
        },
        yolo: {
          type: "boolean",
          description: "Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
      },
      required: ["repo", "prompt"],
    },
  },
  {
    name: "list_peers",
    description: "List all known Codex peers and their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_for_peer",
    description:
      "Block until an existing Codex peer reaches a terminal status, or until timeout_ms elapses.",
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
    name: "spawn_peer_and_wait",
    description:
      "Spawn a supervised headless Codex peer in an isolated linked worktree, then block until it reaches a terminal status or timeout_ms elapses.",
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
        model: { type: "string", description: "Optional Codex model override." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Optional Codex sandbox mode.",
        },
        yolo: {
          type: "boolean",
          description: "Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Run peer with --dangerously-bypass-approvals-and-sandbox.",
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
      "Spawn a peer that drives /gsd-autonomous (dynamic mode) or /gsd-execute-phase (frozen mode) one phase at a time inside Codex CLI. Phase 33 plan 01 creates the spawn record only; the runner (plans 33-02/03) picks gsd_pending peers off the queue. Does NOT auto-integrate; use integrate_peer for review-then-merge.",
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
    name: "integrate_peer",
    description:
      "Integrate a completed peer: stage tracked-file changes in the peer's worktree, commit, merge --no-ff into the target branch, and push to origin. Refuses peers in running/halted/failed states. Per Hard Constraint 4 this is the explicit-invocation path; no other tool in codex-peers triggers a push.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string", minLength: 1, description: "Peer id or id prefix." },
      },
      required: ["peer_id"],
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
          name: "codex-mcp-peers-server",
          title: "Codex MCP Peers",
          version: "0.1.0",
        },
        instructions:
          "Use this MCP server to spawn and supervise headless Codex peers across repositories. New peers run in isolated linked worktrees. By default they start from the origin default branch and merge successful changes back there; callers can choose a separate start_ref and merge_branch. Use list_peers and read_peer_log to monitor progress; use send_peer_reply when a peer reports CODEX_PEERS_STATUS: WAITING.",
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

async function callTool(name: unknown, rawArgs: unknown): Promise<unknown> {
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
    case "spawn_peer_and_wait":
      return json(await spawnPeerAndWait({
        repo: requiredString(args, "repo"),
        prompt: requiredString(args, "prompt"),
        name: optionalString(args, "name"),
        ...branchOptions(args),
        model: optionalString(args, "model"),
        sandbox: optionalString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
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
      console.error(`[codex-peers] invalid JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void this.onRequest(request);
  }
}
