// src/workflow/engine.ts
//
// SP1 wave 1 — the run driver. Executes one workflow script via the sandbox
// executor, bridges ctx.agent/ctx.log calls to the peer machinery (ctx.ts),
// and enforces the wave-1 termination guarantees:
//   - script `return`      → workflow done (result persisted)
//   - wall-clock timeoutMs → workflow halted (child + leaf peers killed)
//   - script throw / infra → workflow failed
//
// A workflow_run record carries no single engine pid, so it is exempt from
// reconciledPeer's frozen detection (like GSD kinds); the engine therefore
// emits its own heartbeat and enforces its own timeout — never the script.
//
// All side effects arrive via injected deps (the gsdRunner testing pattern):
// unit tests drive this loop with fake peers and a fake executor.

import { runAgentCall, type AgentCallDeps } from "./ctx.js";
import type { PeerRecord } from "../types.js";
import type { WorkflowRunConfig } from "./types.js";

export const WORKFLOW_HEARTBEAT_MS = 5000;

export class WorkflowTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`workflow exceeded timeoutMs=${timeoutMs}`);
    this.name = "WorkflowTimeoutError";
  }
}

/** Handle returned by the sandbox executor (sandbox.ts, or a test fake). */
export type ScriptExecution = {
  /** Resolves with the script's return value; rejects on script/child error. */
  result: Promise<unknown>;
  /** Hard-stop the execution (used by the timeout guard). Idempotent. */
  kill: (reason?: string) => void;
};

export type ExecuteScriptRequest = {
  scriptPath: string;
  seed: number;
  startTimeMs: number;
  onCall: (method: string, args: unknown[]) => Promise<unknown>;
};

export type WorkflowEngineDeps = AgentCallDeps & {
  updatePeer: (id: string, patch: Partial<PeerRecord>) => PeerRecord;
  appendLog: (peer: PeerRecord, line: string) => Promise<void>;
  /** Kill a still-active leaf peer when the run is halted. Best-effort. */
  killPeer: (peerId: string) => void;
  executeScript: (request: ExecuteScriptRequest) => ScriptExecution;
  now: () => number;
};

export async function runWorkflowRun(
  peer: PeerRecord,
  deps: WorkflowEngineDeps,
  opts?: { heartbeatMs?: number },
): Promise<PeerRecord> {
  const workflow = peer.workflow;
  if (peer.kind !== "workflow_run" || !workflow) {
    throw new Error(`runWorkflowRun: peer ${peer.id} is not a workflow_run record`);
  }

  const startedAt = deps.now();
  const agentPeerIds: string[] = [];
  let current = patch(deps, peer.id, workflow, {
    status: "working",
    lastEvent: `workflow running: ${workflow.scriptPath}`,
    workflowPatch: { status: "running" },
  });

  const heartbeat = setInterval(() => {
    try {
      current = patch(deps, peer.id, currentWorkflow(current, workflow), {
        workflowPatch: {},
        heartbeatOnly: true,
      });
    } catch {
      /* best-effort */
    }
  }, opts?.heartbeatMs ?? WORKFLOW_HEARTBEAT_MS);

  const log = (line: string) => {
    void deps.appendLog(current, `[workflow] ${line}\n`);
  };

  const onCall = async (method: string, args: unknown[]): Promise<unknown> => {
    if (method === "log") {
      const message = String(args[0] ?? "");
      log(`log: ${message}`);
      current = patch(deps, peer.id, currentWorkflow(current, workflow), {
        lastEvent: trimEvent(message),
        workflowPatch: {},
      });
      return undefined;
    }
    if (method === "agent") {
      const [prompt, agentOpts] = args as [string, Record<string, unknown> | undefined];
      return runAgentCall(
        { ...deps, onAgentSpawned: (leaf) => trackAgent(leaf), log },
        { repo: workflow.repo, waitTimeoutMs: workflow.timeoutMs },
        prompt,
        agentOpts,
      );
    }
    throw new Error(`unknown ctx method: ${method}`);
  };

  const trackAgent = (leaf: PeerRecord) => {
    agentPeerIds.push(leaf.id);
    current = patch(deps, peer.id, currentWorkflow(current, workflow), {
      lastEvent: `agent ${leaf.id} spawned (${agentPeerIds.length} total)`,
      workflowPatch: { agentPeerIds: [...agentPeerIds] },
    });
  };

  const execution = deps.executeScript({
    scriptPath: workflow.scriptPath,
    seed: workflow.seed,
    startTimeMs: workflow.startTimeMs,
    onCall,
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  const guarded =
    workflow.timeoutMs && workflow.timeoutMs > 0
      ? Promise.race([
          execution.result,
          new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              execution.kill(`timeoutMs=${workflow.timeoutMs}`);
              reject(new WorkflowTimeoutError(workflow.timeoutMs as number));
            }, workflow.timeoutMs);
          }),
        ])
      : execution.result;

  try {
    const result = await guarded;
    log(`workflow returned after ${deps.now() - startedAt}ms`);
    current = patch(deps, peer.id, currentWorkflow(current, workflow), {
      status: "done",
      finished: true,
      lastEvent: "workflow done (script returned)",
      workflowPatch: { status: "done", result: toJsonSafe(result), agentPeerIds: [...agentPeerIds] },
    });
    return current;
  } catch (error) {
    const isTimeout = error instanceof WorkflowTimeoutError;
    const message = error instanceof Error ? error.message : String(error);
    if (isTimeout) {
      execution.kill("timeout");
      for (const id of agentPeerIds) {
        try {
          deps.killPeer(id);
        } catch {
          /* already terminal */
        }
      }
    }
    log(`workflow ${isTimeout ? "halted" : "failed"}: ${message}`);
    current = patch(deps, peer.id, currentWorkflow(current, workflow), {
      status: isTimeout ? "halted" : "failed",
      finished: true,
      error: message,
      lastEvent: isTimeout ? `workflow halted: ${message}` : `workflow failed: ${trimEvent(message)}`,
      workflowPatch: { status: isTimeout ? "halted" : "failed", error: message, agentPeerIds: [...agentPeerIds] },
    });
    return current;
  } finally {
    clearInterval(heartbeat);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    execution.kill("run finished");
  }
}

function currentWorkflow(peer: PeerRecord, fallback: WorkflowRunConfig): WorkflowRunConfig {
  return peer.workflow ?? fallback;
}

function patch(
  deps: WorkflowEngineDeps,
  id: string,
  workflow: WorkflowRunConfig,
  update: {
    status?: PeerRecord["status"];
    lastEvent?: string;
    error?: string;
    finished?: boolean;
    heartbeatOnly?: boolean;
    workflowPatch: Partial<WorkflowRunConfig>;
  },
): PeerRecord {
  const nowIso = new Date().toISOString();
  return deps.updatePeer(id, {
    ...(update.status ? { status: update.status } : {}),
    ...(update.lastEvent ? { lastEvent: update.lastEvent } : {}),
    ...(update.error ? { error: update.error } : {}),
    ...(update.finished ? { finishedAt: nowIso } : {}),
    updatedAt: nowIso,
    lastHeartbeatAt: nowIso,
    ...(update.heartbeatOnly ? {} : { workflow: { ...workflow, ...update.workflowPatch } }),
  });
}

function trimEvent(text: string): string {
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

/** The script result crosses IPC as JSON; guard against exotic values. */
function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
