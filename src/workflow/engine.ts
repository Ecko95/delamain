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
import { RunController, resolveMaxConcurrency, type RunControllerDeps } from "./pool.js";
import { ReplayPlan, hashOpts, hashPrompt } from "./journal.js";
import type { AgentJournalRow } from "../store.js";
import type { PeerRecord } from "../types.js";
import type { WorkflowRunConfig } from "./types.js";

export const WORKFLOW_HEARTBEAT_MS = 5000;

export class WorkflowTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`workflow exceeded timeoutMs=${timeoutMs}`);
    this.name = "WorkflowTimeoutError";
  }
}

/** Thrown internally to route a guard-halted run to the `halted` status. */
export class WorkflowHaltedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowHaltedError";
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
  /** Total token budget the child mirrors via ctx.budget (null = uncapped). */
  budgetTotal: number | null;
  /** Opaque object exposed to the script as the `args` global (undefined when absent). */
  args?: Record<string, unknown>;
  /** Live token spend the executor stamps on each reply to the child. */
  getBudgetSpent: () => number;
  /** Loud degraded-mode / jail-status notices routed to the run log. */
  onWarning?: (message: string) => void;
  onCall: (method: string, args: unknown[]) => Promise<unknown>;
};

export type WorkflowEngineDeps = AgentCallDeps &
  RunControllerDeps & {
    updatePeer: (id: string, patch: Partial<PeerRecord>) => PeerRecord;
    appendLog: (peer: PeerRecord, line: string) => Promise<void>;
    /** Kill a still-active leaf peer when the run is halted. Best-effort. */
    killPeer: (peerId: string) => void;
    executeScript: (request: ExecuteScriptRequest) => ScriptExecution;
    // SP1 wave 3 — resume/journaling (§14). Injected so replay is testable.
    readJournal: (workflowId: string) => AgentJournalRow[];
    writeJournal: (row: AgentJournalRow) => void;
    // SP1 wave 4 — event stream (§11). Injected so emission is testable; a
    // no-op default keeps unit tests that don't care about events simple.
    emitEvent?: (workflowId: string, type: string, payload: Record<string, unknown>) => void;
    now: () => number;
  };

export async function runWorkflowRun(
  peer: PeerRecord,
  deps: WorkflowEngineDeps,
  opts?: { heartbeatMs?: number; maxConcurrency?: number },
): Promise<PeerRecord> {
  const workflow = peer.workflow;
  if (peer.kind !== "workflow_run" || !workflow) {
    throw new Error(`runWorkflowRun: peer ${peer.id} is not a workflow_run record`);
  }

  const startedAt = deps.now();
  const agentPeerIds: string[] = [];
  const emit = (type: string, payload: Record<string, unknown>) => {
    try {
      deps.emitEvent?.(peer.id, type, payload);
    } catch {
      /* telemetry must never fail the run */
    }
  };
  const seenPhases = new Set<string>();
  // Resume: replay the longest unchanged prefix of ctx.agent() calls from the
  // journal (empty for a fresh run → every call runs live and is journaled).
  const replayPlan = new ReplayPlan(deps.readJournal(peer.id));
  let current = patch(deps, peer.id, workflow, {
    status: "working",
    lastEvent: `workflow running: ${workflow.scriptPath}`,
    workflowPatch: { status: "running" },
  });
  emit("workflow_start", {
    name: peer.name ?? workflow.scriptPath,
    scriptPath: workflow.scriptPath,
    maxAgents: workflow.maxAgents ?? null,
    budgetTokens: workflow.budgetTokens ?? null,
  });

  const log = (line: string) => {
    void deps.appendLog(current, `[workflow] ${line}\n`);
  };

  // The agent pool: ONE semaphore + the maxAgents/budgetTokens guards. Every
  // ctx.agent leaf passes through controller.acquire before spawnPeer.
  const controller = new RunController({
    maxConcurrency: opts?.maxConcurrency ?? resolveMaxConcurrency(),
    guards: { maxAgents: workflow.maxAgents, budgetTokens: workflow.budgetTokens },
    deps: { tokensForPeer: deps.tokensForPeer, killPeer: deps.killPeer, log },
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
      const [prompt, rawOpts, callIndexRaw] = args as [string, Record<string, unknown> | null, number | undefined];
      const agentOpts = rawOpts ?? undefined;
      const callIndex = typeof callIndexRaw === "number" ? callIndexRaw : -1;
      const promptHash = hashPrompt(prompt);
      const optsHash = hashOpts(agentOpts);

      // Resume: serve from the journal when this call is within the unchanged
      // prefix. No spawn, no semaphore, no budget — the work already happened.
      if (callIndex >= 0) {
        const decision = replayPlan.decide(callIndex, promptHash, optsHash);
        if (decision.replay) {
          log(`agent[${callIndex}] replayed from journal (cache hit)`);
          current = patch(deps, peer.id, currentWorkflow(current, workflow), {
            workflowPatch: { replayedAgents: replayPlan.replayedCount },
          });
          return decision.result;
        }
      }

      const phase = agentOpts?.phase as string | undefined;
      if (phase && !seenPhases.has(phase)) {
        seenPhases.add(phase);
        emit("phase_start", { phase });
      }
      const agentStart = deps.now();
      let leafId: string | undefined;
      try {
        const result = await runAgentCall(
          {
            ...deps,
            onAgentSpawned: (leaf) => {
              leafId = leaf.id;
              controller.markSpawned(leaf);
              trackAgent(leaf);
              emit("agent_spawn", { node: leaf.id, engine: agentOpts?.engine ?? "codex", model: agentOpts?.model ?? null, phase: phase ?? null, callIndex });
            },
            acquire: controller.acquire,
            release: controller.release,
            recordUsage: controller.recordUsage,
            log,
          },
          { repo: workflow.repo, waitTimeoutMs: workflow.timeoutMs },
          prompt,
          agentOpts,
        );

        // Durably journal the completed call BEFORE returning it to the script,
        // so a crash immediately after can still replay this call on resume.
        if (callIndex >= 0) {
          try {
            deps.writeJournal({
              workflowId: peer.id,
              callIndex,
              promptHash,
              optsHash,
              engine: (agentOpts?.engine as string) ?? "codex",
              model: agentOpts?.model as string | undefined,
              phase,
              resultJson: JSON.stringify(result ?? null),
              status: "done",
            });
          } catch {
            /* journaling is best-effort; a failed write just means a re-run here on resume */
          }
        }
        emit("agent_done", { node: leafId ?? null, status: "done", phase: phase ?? null, callIndex, elapsedMs: deps.now() - agentStart, tokensSpent: controller.budgetSnapshot().spent });
        return result;
      } catch (err) {
        emit("agent_failed", { node: leafId ?? null, phase: phase ?? null, callIndex, elapsedMs: deps.now() - agentStart, err: err instanceof Error ? err.message : String(err) });
        throw err;
      }
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

  // A guard trip (maxAgents/budgetTokens/timeout) halts the run: kill the
  // child AND settle the awaited result immediately via haltSignal, so a child
  // that ignores kill can't keep the run alive. Registered BEFORE executeScript
  // so a guard that trips synchronously (e.g. an agent spawned during startup)
  // is still handled.
  let execution: ScriptExecution | undefined;
  let haltReject: ((err: Error) => void) | undefined;
  const haltSignal = new Promise<never>((_, reject) => {
    haltReject = reject;
  });
  controller.onHalt((reason) => {
    execution?.kill("guard tripped");
    haltReject?.(new WorkflowHaltedError(reason));
  });

  execution = deps.executeScript({
    scriptPath: workflow.scriptPath,
    seed: workflow.seed,
    startTimeMs: workflow.startTimeMs,
    budgetTotal: workflow.budgetTokens ?? null,
    args: workflow.args,
    getBudgetSpent: () => controller.budgetSnapshot().spent,
    onWarning: (message) => log(message),
    onCall,
  });
  // If a guard tripped synchronously while the executor started, the child was
  // spawned after the onHalt kill ran — stop it now.
  if (controller.haltReason) {
    execution.kill("guard tripped");
  }

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (workflow.timeoutMs && workflow.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      controller.halt(`timeoutMs=${workflow.timeoutMs}`);
    }, workflow.timeoutMs);
  }

  try {
    const result = await Promise.race([execution.result, haltSignal]);
    // The child can resolve after a halt if it caught the abort; honor the halt.
    if (controller.haltReason) {
      throw new WorkflowHaltedError(controller.haltReason);
    }
    log(`workflow returned after ${deps.now() - startedAt}ms`);
    current = patch(deps, peer.id, currentWorkflow(current, workflow), {
      status: "done",
      finished: true,
      lastEvent: "workflow done (script returned)",
      workflowPatch: {
        status: "done",
        result: toJsonSafe(result),
        agentPeerIds: [...agentPeerIds],
        tokensSpent: controller.budgetSnapshot().spent,
        replayedAgents: replayPlan.replayedCount,
      },
    });
    emit("workflow_end", {
      status: "done",
      elapsedMs: deps.now() - startedAt,
      totalAgents: agentPeerIds.length,
      replayedAgents: replayPlan.replayedCount,
      tokensSpent: controller.budgetSnapshot().spent,
    });
    return current;
  } catch (error) {
    const haltReason = controller.haltReason;
    const isHalt = haltReason !== undefined || error instanceof WorkflowHaltedError || error instanceof WorkflowTimeoutError;
    const message = haltReason ?? (error instanceof Error ? error.message : String(error));
    // Ensure no leaf outlives the run, whatever the exit path.
    controller.killAllLeaves();
    log(`workflow ${isHalt ? "halted" : "failed"}: ${message}`);
    current = patch(deps, peer.id, currentWorkflow(current, workflow), {
      status: isHalt ? "halted" : "failed",
      finished: true,
      error: message,
      lastEvent: isHalt ? `workflow halted: ${message}` : `workflow failed: ${trimEvent(message)}`,
      workflowPatch: {
        status: isHalt ? "halted" : "failed",
        error: message,
        agentPeerIds: [...agentPeerIds],
        tokensSpent: controller.budgetSnapshot().spent,
        replayedAgents: replayPlan.replayedCount,
      },
    });
    emit("workflow_end", {
      status: isHalt ? "halted" : "failed",
      error: message,
      elapsedMs: deps.now() - startedAt,
      totalAgents: agentPeerIds.length,
      replayedAgents: replayPlan.replayedCount,
      tokensSpent: controller.budgetSnapshot().spent,
    });
    return current;
  } finally {
    clearInterval(heartbeat);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    execution?.kill("run finished");
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
