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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killPeer, resumePeer, spawnPeer, waitForPeer } from "../peerManager.js";
import { runsDir } from "../paths.js";
import { getPeer, updatePeer, upsertPeer } from "../store.js";
import type { PeerRecord } from "../types.js";
import { runWorkflowRun, type WorkflowEngineDeps } from "./engine.js";
import { executeWorkflowScript } from "./sandbox.js";
import { isWorkflowRunRecord } from "./types.js";

export type SpawnWorkflowRunOptions = {
  /** Repository the workflow's agents run against. */
  repo: string;
  scriptPath: string;
  timeoutMs?: number;
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
      status: "pending",
      agentPeerIds: [],
      // Parent-side nondeterminism is fine; the sandbox child only ever sees
      // these frozen values (§14 determinism shims).
      seed: Math.floor(Math.random() * 0xffffffff),
      startTimeMs: Date.now(),
    },
    lastEvent: `workflow queued: ${scriptPath}${options.timeoutMs ? ` (timeoutMs=${options.timeoutMs})` : ""}`,
  };
  upsertPeer(peer);
  return peer;
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
  const existing = workflowRunners.get(peer.id);
  if (existing) {
    return existing;
  }
  const deps: WorkflowEngineDeps = { ...buildRealDeps(), ...depsOverride };
  const promise = runWorkflowRun(peer, deps).catch((err: Error) => {
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
  });
  workflowRunners.set(peer.id, promise);
  return promise;
}

/** Test-only hook to await a dispatched workflow. Not exposed via MCP. */
export function _awaitWorkflowRun(workflowId: string): Promise<PeerRecord> | undefined {
  return workflowRunners.get(workflowId);
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

/** Child entrypoint for `delamain run-workflow-runner --workflow-id <id>`. */
export async function runWorkflowRunnerChild(argv: string[]): Promise<void> {
  const idIndex = argv.indexOf("--workflow-id");
  const workflowId = idIndex !== -1 ? argv[idIndex + 1] : undefined;
  if (!workflowId) {
    throw new Error("run-workflow-runner requires --workflow-id");
  }
  updatePeer(workflowId, (current) => ({
    ...current,
    runnerPid: process.pid,
    updatedAt: new Date().toISOString(),
  }));
  await dispatchWorkflow(workflowId);
}

function buildRealDeps(): WorkflowEngineDeps {
  return {
    spawnPeer,
    waitForPeer,
    resumePeer,
    killPeer: (peerId) => {
      killPeer(peerId);
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
    now: () => Date.now(),
  };
}
