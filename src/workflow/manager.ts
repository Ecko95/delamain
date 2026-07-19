// src/workflow/manager.ts
//
// SP1 wave 1 — enqueue/dispatch/await for workflow runs, mirroring the GSD
// trio (spawnGsdPhaseBatch / dispatchGsdPeer / _awaitGsdRunner):
//   spawnWorkflowRun    — persist the workflow_run record (no process)
//   spawnWorkflowRunner — detached `run-workflow-runner` child (run-peer's sibling)
//   dispatchWorkflow    — fire-and-forget Map<id, Promise> driving engine.ts
//   runWorkflowRunnerChild — the child entrypoint (index.ts "run-workflow-runner")

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killPeer, resumePeer, spawnPeer, waitForPeer } from "../peerManager.js";
import { readPeerCost } from "../peerCost.js";
import { peersHome, runsDir } from "../paths.js";
import { killPid, pidAlive } from "../processes.js";
import { getPeer, journalAgentCall, readAgentJournal, readState, readWorkflowEvents, updatePeer, upsertPeer } from "../store.js";
import { TERMINAL_PEER_STATUSES, type PeerRecord } from "../types.js";
import { runWorkflowRun, type WorkflowEngineDeps } from "./engine.js";
import { emitWorkflowEvent, type WorkflowEventType } from "./events.js";
import { executeWorkflowScript } from "./sandbox.js";
import { isWorkflowRunRecord } from "./types.js";

export type SpawnWorkflowRunOptions = {
  /** Repository the workflow's agents run against. */
  repo: string;
  scriptPath: string;
  timeoutMs?: number;
  /** Hard cap on total leaves (termination guard). */
  maxAgents?: number;
  /** Cumulative leaf-token budget (termination guard). */
  budgetTokens?: number;
  name?: string;
};

/** Persist a workflow_run record. No worktree, no process (dispatch is separate). */
export function spawnWorkflowRun(options: SpawnWorkflowRunOptions): PeerRecord {
  const id = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const logPath = join(runsDir(), `${startedAt.replace(/[:.]/g, "-")}-wf-${id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "", "utf8");
  const scriptPath = resolve(options.scriptPath);

  const peer: PeerRecord = {
    id,
    name: options.name,
    repo: resolve(options.repo),
    task: `workflow: ${scriptPath}`,
    status: "starting",
    startedAt,
    updatedAt: startedAt,
    lastHeartbeatAt: startedAt,
    logPath,
    kind: "workflow_run",
    workflow: {
      scriptPath,
      repo: resolve(options.repo),
      timeoutMs: options.timeoutMs,
      maxAgents: options.maxAgents,
      budgetTokens: options.budgetTokens,
      status: "pending",
      agentPeerIds: [],
      // Parent-side nondeterminism is fine; the sandbox child only ever sees
      // these frozen values (§14 determinism shims).
      seed: Math.floor(Math.random() * 0xffffffff),
      startTimeMs: Date.now(),
    },
    lastEvent: `workflow queued: ${scriptPath}${guardSummary(options)}`,
  };
  upsertPeer(peer);
  return peer;
}

function guardSummary(options: SpawnWorkflowRunOptions): string {
  const parts: string[] = [];
  if (options.timeoutMs) parts.push(`timeoutMs=${options.timeoutMs}`);
  if (options.maxAgents) parts.push(`maxAgents=${options.maxAgents}`);
  if (options.budgetTokens) parts.push(`budgetTokens=${options.budgetTokens}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export type WorkflowRunnerSpawnArgs = { workflowId: string };

/** Pure argv builder for the detached child — unit-testable like buildRunnerArgv. */
export function buildWorkflowRunnerArgv(args: WorkflowRunnerSpawnArgs): string[] {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  return [entry, "run-workflow-runner", "--workflow-id", args.workflowId];
}

/** Detached dispatcher child, sibling of spawnRunner's run-peer. */
export function spawnWorkflowRunner(workflowId: string) {
  const child = spawn(process.execPath, buildWorkflowRunnerArgv({ workflowId }), {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  updatePeer(workflowId, (current) => ({
    ...current,
    runnerPid: child.pid,
    updatedAt: new Date().toISOString(),
    lastEvent: `workflow runner pid=${child.pid ?? "unknown"}`,
  }));
  return child;
}

const workflowRunners = new Map<string, Promise<PeerRecord>>();

/** Fire-and-forget engine dispatch (Map-deduped, like dispatchGsdPeer). */
export function dispatchWorkflow(
  workflowId: string,
  depsOverride?: Partial<WorkflowEngineDeps>,
): Promise<PeerRecord> {
  const peer = getPeer(workflowId);
  if (!peer) {
    throw new Error(`dispatchWorkflow: unknown workflow ${workflowId}`);
  }
  if (!isWorkflowRunRecord(peer)) {
    throw new Error(`dispatchWorkflow: peer ${workflowId} kind=${peer.kind ?? "generic"} is not a workflow_run`);
  }
  // Dedupe only CONCURRENT dispatches of the same id; a settled run is evicted
  // so it can be re-dispatched (that is exactly a resume — replay the journal).
  const existing = workflowRunners.get(peer.id);
  if (existing) {
    return existing;
  }
  const deps: WorkflowEngineDeps = { ...buildRealDeps(), ...depsOverride };
  const promise = runWorkflowRun(peer, deps)
    .catch((err: Error) => {
      const merged = updatePeer(peer.id, (current) => ({
        ...current,
        status: "failed",
        error: err.message,
        lastEvent: `workflow engine threw: ${err.message}`,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        workflow: current.workflow ? { ...current.workflow, status: "failed", error: err.message } : current.workflow,
      }));
      if (!merged) throw err;
      return merged;
    })
    .finally(() => {
      workflowRunners.delete(peer.id);
    });
  workflowRunners.set(peer.id, promise);
  return promise;
}

/** Test-only hook to await a dispatched workflow. Not exposed via MCP. */
export function _awaitWorkflowRun(workflowId: string): Promise<PeerRecord> | undefined {
  return workflowRunners.get(workflowId);
}

/** All workflow_run records, newest first (mirrors listPeers ordering). */
export function listWorkflows(): PeerRecord[] {
  return readState().peers.filter((p) => p.kind === "workflow_run");
}

/** Lifecycle events for a workflow with seq > since (default all). */
export function workflowEvents(workflowId: string, since = 0) {
  return readWorkflowEvents(workflowId, since);
}

export function workflowStatus(workflowId: string): PeerRecord {
  const peer = getPeer(workflowId);
  if (!peer) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  if (peer.kind !== "workflow_run") {
    throw new Error(`Peer ${peer.id} is not a workflow_run (kind=${peer.kind ?? "generic"})`);
  }
  return peer;
}

export type WorkflowKillResult = { workflowId: string; status: string; peersKilled: string[] };

/**
 * Cockpit contract 2: stop a running workflow. Idempotent — an already-terminal
 * workflow returns its current status and kills nothing. Otherwise: SIGTERM the
 * detached runner, kill each still-live leaf agent peer, persist "killed", and
 * emit a durable workflow_end so the T3 mirror closes the thread.
 *
 * deps are injected so the store transition + emitted event are testable without
 * spawning real processes.
 */
export function killWorkflowRun(
  workflowId: string,
  deps: {
    killPid?: (pid: number | undefined, signal?: NodeJS.Signals) => boolean;
    killPeer?: (peerId: string, signal?: NodeJS.Signals) => unknown;
    emit?: (workflowId: string, type: WorkflowEventType, payload: Record<string, unknown>) => void;
  } = {},
): WorkflowKillResult {
  const kPid = deps.killPid ?? killPid;
  const kPeer = deps.killPeer ?? killPeer;
  const emit = deps.emit ?? emitWorkflowEvent;

  const peer = workflowStatus(workflowId);
  if (TERMINAL_PEER_STATUSES.has(peer.status)) {
    return { workflowId: peer.id, status: peer.status, peersKilled: [] };
  }

  // SIGTERM the runner if it's still alive.
  if (peer.runnerPid && pidAlive(peer.runnerPid)) {
    kPid(peer.runnerPid, "SIGTERM");
  }

  // Kill still-live leaf agent peers spawned by this run.
  const peersKilled: string[] = [];
  for (const agentId of peer.workflow?.agentPeerIds ?? []) {
    const agent = getPeer(agentId);
    if (!agent || TERMINAL_PEER_STATUSES.has(agent.status)) continue;
    kPeer(agent.id, "SIGTERM");
    peersKilled.push(agent.id);
  }

  updatePeer(peer.id, (current) => ({
    ...current,
    status: "killed",
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEvent: "workflow killed",
    workflow: current.workflow ? { ...current.workflow, status: "halted" } : current.workflow,
  }));

  emit(peer.id, "workflow_end", { status: "killed", peersKilled });

  return { workflowId: peer.id, status: "killed", peersKilled };
}

/** Child entrypoint for `delamain run-workflow-runner --workflow-id <id>`. */
export async function runWorkflowRunnerChild(argv: string[]): Promise<void> {
  const idIndex = argv.indexOf("--workflow-id");
  const workflowId = idIndex !== -1 ? argv[idIndex + 1] : undefined;
  if (!workflowId) {
    throw new Error("run-workflow-runner requires --workflow-id");
  }
  const release = acquireRunLock(workflowId);
  if (!release) {
    // Another runner process owns this workflow; don't double-drive it.
    updatePeer(workflowId, (current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      lastEvent: "resume refused: workflow already running in another process",
    }));
    return;
  }
  updatePeer(workflowId, (current) => ({
    ...current,
    runnerPid: process.pid,
    updatedAt: new Date().toISOString(),
  }));
  try {
    await dispatchWorkflow(workflowId);
  } finally {
    release();
  }
}

function buildRealDeps(): WorkflowEngineDeps {
  return {
    spawnPeer,
    waitForPeer,
    resumePeer,
    killPeer: (peerId) => {
      killPeer(peerId);
    },
    tokensForPeer: (peer) => {
      try {
        const cost = readPeerCost(peer);
        return cost.totals ? cost.totals.input + cost.totals.output : 0;
      } catch {
        return 0;
      }
    },
    readAgentResultFile: (peer) => {
      try {
        return readFileSync(join(peer.repo, ".delamain", "result.json"), "utf8");
      } catch {
        return undefined;
      }
    },
    removeAgentResultFile: (peer) => {
      try {
        rmSync(join(peer.repo, ".delamain", "result.json"), { force: true });
      } catch {
        /* best-effort */
      }
    },
    updatePeer: (id, patch) => {
      const merged = updatePeer(id, (current) => ({ ...current, ...patch }));
      if (!merged) {
        throw new Error(`workflow updatePeer: peer ${id} not found`);
      }
      return merged;
    },
    appendLog: async (peer, line) => {
      try {
        await appendFile(peer.logPath, line, "utf8");
      } catch {
        /* log append best-effort */
      }
    },
    executeScript: executeWorkflowScript,
    readJournal: (workflowId) => readAgentJournal(workflowId),
    writeJournal: (row) => journalAgentCall(row),
    emitEvent: (workflowId, type, payload) => emitWorkflowEvent(workflowId, type as WorkflowEventType, payload),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// SP1 wave 3 — resume + run lock (§14).
// ---------------------------------------------------------------------------

/**
 * Re-dispatch an existing workflow_run record. Its journal (from the prior,
 * possibly killed, run) is preserved; the engine replays the longest unchanged
 * prefix and runs only the remainder live. Seed/startTimeMs are kept so the
 * determinism shims produce the same execution.
 */
export function resumeWorkflowRun(workflowId: string): PeerRecord {
  const peer = getPeer(workflowId);
  if (!peer) {
    throw new Error(`resumeWorkflowRun: unknown workflow ${workflowId}`);
  }
  if (!isWorkflowRunRecord(peer)) {
    throw new Error(`resumeWorkflowRun: peer ${workflowId} is not a workflow_run (kind=${peer.kind ?? "generic"})`);
  }
  if (peer.status === "working" || peer.status === "starting") {
    throw new Error(`resumeWorkflowRun: workflow ${peer.id} is still active (${peer.status}); kill it before resuming`);
  }
  const reset = updatePeer(peer.id, (current) => ({
    ...current,
    status: "starting",
    error: undefined,
    finishedAt: undefined,
    updatedAt: new Date().toISOString(),
    lastEvent: `resume requested (${current.workflow?.agentPeerIds?.length ?? 0} prior agents journaled)`,
    workflow: current.workflow ? { ...current.workflow, status: "pending", error: undefined } : current.workflow,
  }));
  const record = reset ?? peer;
  spawnWorkflowRunner(record.id);
  return record;
}

function lockPath(workflowId: string): string {
  return join(peersHome(), "workflow-locks", `${workflowId}.lock`);
}

/**
 * Cross-process run lock so a workflow id can't be driven by two runner
 * processes at once (e.g. a resume racing a still-live run). Reuses the gsd-pi
 * lockfile + pid-liveness pattern: a stale lock whose owner is dead is stolen.
 * Returns a release fn, or null when the workflow is already running.
 */
export function acquireRunLock(workflowId: string): (() => void) | null {
  const path = lockPath(workflowId);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // Lock exists — steal it only if the owner pid is dead.
      let ownerPid: number | undefined;
      try {
        ownerPid = Number(readFileSync(path, "utf8").trim()) || undefined;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid && pidAlive(ownerPid)) {
        return null; // genuinely running elsewhere
      }
      try {
        unlinkSync(path); // stale → remove and retry once
      } catch {
        /* raced with another stealer */
      }
    }
  }
  return null;
}
