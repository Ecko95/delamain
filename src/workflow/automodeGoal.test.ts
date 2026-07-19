// Slice D — automode goals as labeled delamain workflows.
//   1. args round-trip through the engine seam, incl. resume-replay identity
//   2. the shipped workflows/automode-goal.ts passes the sandbox AST guard
//   3. the automode-goal opts (prompt/label/model/startRef/mergeBranch) reach
//      the leaf spawn exactly, with integrate ON
//   4. rails-default regression: a plain workflow leaf still spawns push-free
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PeerRecord, SpawnPeerOptions } from "../types.js";
import { runAgentCall, type AgentCallDeps } from "./ctx.js";
import { runWorkflowRun, type ExecuteScriptRequest, type WorkflowEngineDeps } from "./engine.js";
import { validateWorkflowSource } from "./sandbox.js";
import type { WorkflowRunConfig } from "./types.js";

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "automode-goal.ts");

// --- leaf-spawn stub (mirrors ctx.test's fake) ----------------------------
function makeLeafDeps() {
  const spawns: SpawnPeerOptions[] = [];
  const basePeer: PeerRecord = {
    id: "leaf-1",
    repo: "/tmp/wt",
    task: "task",
    status: "done",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/tmp/log",
    finalResult: "landed",
  };
  const deps: AgentCallDeps = {
    spawnPeer: (options) => {
      spawns.push(options);
      return { ...basePeer };
    },
    waitForPeer: async ({ peerId }) => ({ peer: { ...basePeer, id: peerId }, timedOut: false, elapsedMs: 1 }),
    resumePeer: () => ({ ...basePeer }),
    readAgentResultFile: () => undefined,
    removeAgentResultFile: () => {},
  };
  return { deps, spawns };
}

describe("automode-goal workflow (Slice D)", () => {
  it("the shipped workflow passes the sandbox AST guard", () => {
    expect(() => validateWorkflowSource(readFileSync(WORKFLOW_PATH, "utf8"), WORKFLOW_PATH)).not.toThrow();
  });

  it("the automode-goal opts reach the leaf spawn exactly, integrate ON", async () => {
    const { deps, spawns } = makeLeafDeps();
    // Exactly the opts workflows/automode-goal.ts builds from its args.
    await runAgentCall(deps, { repo: "/goal-repo" }, "Episode 7\n\nImplement the thing verbatim", {
      label: "Motoko Proposal · widget",
      model: "claude-opus-4-8",
      startRef: "integration/mk-42",
      mergeBranch: "integration/mk-42",
      integrate: true,
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      repo: "/goal-repo",
      prompt: "Episode 7\n\nImplement the thing verbatim",
      name: "Motoko Proposal · widget",
      model: "claude-opus-4-8",
      startRef: "integration/mk-42",
      mergeBranch: "integration/mk-42",
      integrate: true,
    });
  });

  it("rails default to push-free for every other workflow leaf (regression)", async () => {
    const { deps, spawns } = makeLeafDeps();
    await runAgentCall(deps, { repo: "/repo" }, "review something");
    expect(spawns[0].integrate).toBe(false);
    expect(spawns[0].startRef).toBeUndefined();
    expect(spawns[0].mergeBranch).toBeUndefined();
  });

  it("persists --args-json and hands the identical object to the sandbox on every (re-)dispatch", async () => {
    const goalArgs = { title: "widget", prompt: "do it", startRef: null, mergeBranch: "integration/x", model: null };
    const record = makeArgsRecord(goalArgs);
    const seen: Array<Record<string, unknown> | undefined> = [];
    const deps = makeCapturingDeps((req) => seen.push(req.args));

    // Fresh dispatch, then a re-dispatch (== resume: same persisted record).
    await runWorkflowRun(record, deps);
    await runWorkflowRun(makeArgsRecord(goalArgs), deps);

    expect(seen[0]).toEqual(goalArgs);
    expect(seen[1]).toEqual(seen[0]); // resume-replay identity
  });
});

function makeArgsRecord(args: Record<string, unknown>): PeerRecord {
  const workflow: WorkflowRunConfig = {
    scriptPath: "/tmp/automode-goal.ts",
    repo: "/repo",
    status: "pending",
    agentPeerIds: [],
    seed: 1,
    startTimeMs: 1,
    args,
  };
  return {
    id: "wf-args",
    repo: "/repo",
    task: "workflow",
    status: "starting",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/tmp/wf.log",
    kind: "workflow_run",
    workflow,
  };
}

function makeCapturingDeps(onExecute: (req: ExecuteScriptRequest) => void): WorkflowEngineDeps {
  return {
    spawnPeer: () => {
      throw new Error("not used");
    },
    waitForPeer: async () => {
      throw new Error("not used");
    },
    resumePeer: () => {
      throw new Error("not used");
    },
    readAgentResultFile: () => undefined,
    removeAgentResultFile: () => {},
    updatePeer: (id, patch) => ({
      id,
      repo: "/repo",
      task: "t",
      status: "starting",
      startedAt: "t",
      updatedAt: "t",
      logPath: "/tmp/wf.log",
      kind: "workflow_run",
      workflow: { scriptPath: "/tmp/automode-goal.ts", repo: "/repo", status: "pending", agentPeerIds: [], seed: 1, startTimeMs: 1 },
      ...patch,
    }),
    appendLog: async () => {},
    killPeer: () => {},
    tokensForPeer: () => 0,
    readJournal: () => [],
    writeJournal: () => {},
    executeScript: (request) => {
      onExecute(request);
      return { result: Promise.resolve(null), kill: () => {} };
    },
    now: () => Date.now(),
  };
}
