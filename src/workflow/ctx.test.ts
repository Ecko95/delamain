import { describe, expect, it } from "vitest";
import type { PeerRecord, SpawnPeerOptions } from "../types.js";
import { WorkflowAgentError, runAgentCall, type AgentCallDeps } from "./ctx.js";

const RISK_SCHEMA = {
  type: "object",
  required: ["risk", "severity"],
  properties: {
    risk: { type: "string" },
    severity: { enum: ["low", "med", "high"] },
  },
};

type FakePeerScript = Array<Partial<PeerRecord>>;

/**
 * Fake peer harness: each entry of `script` is the terminal peer state
 * returned by the Nth waitForPeer call (spawn is call 0; each resume advances
 * to the next entry).
 */
function makeFakeDeps(script: FakePeerScript, resultFiles: Array<string | undefined> = []) {
  const calls = {
    spawns: [] as SpawnPeerOptions[],
    resumes: [] as string[],
    removedResultFile: 0,
    spawnedIds: [] as string[],
  };
  let waitIndex = -1;
  const basePeer: PeerRecord = {
    id: "leaf-1",
    repo: "/tmp/wt",
    task: "task",
    status: "starting",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/tmp/log",
  };
  const deps: AgentCallDeps = {
    spawnPeer: (options) => {
      calls.spawns.push(options);
      return { ...basePeer };
    },
    waitForPeer: async ({ peerId }) => {
      waitIndex += 1;
      const overlay = script[Math.min(waitIndex, script.length - 1)];
      return { peer: { ...basePeer, id: peerId, ...overlay }, timedOut: false, elapsedMs: 5 };
    },
    resumePeer: ({ prompt }) => {
      calls.resumes.push(prompt);
      return { ...basePeer };
    },
    readAgentResultFile: () => resultFiles[Math.min(waitIndex, resultFiles.length - 1)],
    removeAgentResultFile: () => {
      calls.removedResultFile += 1;
    },
    onAgentSpawned: (peer) => calls.spawnedIds.push(peer.id),
  };
  return { deps, calls };
}

describe("runAgentCall", () => {
  it("spawns exactly one codex peer with integrate:false and the schema instruction appended", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done" }], ['{"risk":"r","severity":"low"}']);
    await runAgentCall(deps, { repo: "/repo" }, "Review src/store.ts", { schema: RISK_SCHEMA, label: "reviewer" });
    expect(calls.spawns).toHaveLength(1);
    expect(calls.spawns[0].integrate).toBe(false);
    expect(calls.spawns[0].engine).toBe("codex");
    expect(calls.spawns[0].name).toBe("reviewer");
    expect(calls.spawns[0].prompt).toContain("Review src/store.ts");
    expect(calls.spawns[0].prompt).toContain("STRUCTURED OUTPUT REQUIRED");
    expect(calls.spawnedIds).toEqual(["leaf-1"]);
  });

  it("returns the validated object from the result file", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done" }], ['{"risk":"whole-file RMW races","severity":"high"}']);
    const result = await runAgentCall(deps, { repo: "/repo" }, "p", { schema: RISK_SCHEMA });
    expect(result).toEqual({ risk: "whole-file RMW races", severity: "high" });
    expect(calls.resumes).toHaveLength(0);
  });

  it("returns finalResult as a plain string when no schema is given (no result-file read)", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done", finalResult: "free text report" }]);
    const result = await runAgentCall(deps, { repo: "/repo" }, "p");
    expect(result).toBe("free text report");
    expect(calls.resumes).toHaveLength(0);
  });

  it("resumes with the validation errors on mismatch, then succeeds", async () => {
    const { deps, calls } = makeFakeDeps(
      [{ status: "done" }, { status: "done" }],
      ['{"risk":"missing severity"}', '{"risk":"fixed","severity":"med"}'],
    );
    const result = await runAgentCall(deps, { repo: "/repo" }, "p", { schema: RISK_SCHEMA });
    expect(result).toEqual({ risk: "fixed", severity: "med" });
    expect(calls.resumes).toHaveLength(1);
    expect(calls.resumes[0]).toContain("failed validation");
    expect(calls.resumes[0]).toContain("severity");
    expect(calls.removedResultFile).toBe(1);
  });

  it("throws after exactly 2 retries when the mismatch persists", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done" }], ['{"nope":true}']);
    await expect(runAgentCall(deps, { repo: "/repo" }, "p", { schema: RISK_SCHEMA })).rejects.toThrow(
      /failed schema validation after 2 retries/,
    );
    expect(calls.resumes).toHaveLength(2);
  });

  it("counts an unparseable result (no JSON anywhere) as a mismatch and retries", async () => {
    const { deps, calls } = makeFakeDeps(
      [{ status: "done", finalResult: "sorry, prose only" }, { status: "done" }],
      [undefined, '{"risk":"ok","severity":"low"}'],
    );
    const result = await runAgentCall(deps, { repo: "/repo" }, "p", { schema: RISK_SCHEMA });
    expect(result).toEqual({ risk: "ok", severity: "low" });
    expect(calls.resumes).toHaveLength(1);
    expect(calls.resumes[0]).toContain("no parseable JSON");
  });

  it("throws on a failed peer without resuming", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "failed", error: "codex crashed" }]);
    await expect(runAgentCall(deps, { repo: "/repo" }, "p", { schema: RISK_SCHEMA })).rejects.toThrow(/status failed: codex crashed/);
    expect(calls.resumes).toHaveLength(0);
  });

  it("throws on a waiting peer (interactive agents unsupported)", async () => {
    const { deps } = makeFakeDeps([{ status: "waiting", question: "which file?" }]);
    await expect(runAgentCall(deps, { repo: "/repo" }, "p")).rejects.toThrow(/waiting for orchestrator input/);
  });

  it("spawns a cursor leaf and forwards cursorOptions (SP1 wave 4)", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done", finalResult: "ok" }]);
    await runAgentCall(deps, { repo: "/repo" }, "p", {
      engine: "cursor",
      cursorOptions: { cloud: true, approveMcps: true },
    });
    expect(calls.spawns).toHaveLength(1);
    expect(calls.spawns[0].engine).toBe("cursor");
    expect(calls.spawns[0].cursorOptions).toEqual({ cloud: true, approveMcps: true });
    expect(calls.spawns[0].codexConfig).toBeUndefined();
  });

  it("rejects engine 'pi' with an SP2 message (reserved)", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done" }]);
    await expect(runAgentCall(deps, { repo: "/repo" }, "p", { engine: "pi" })).rejects.toThrow(/SP2/);
    expect(calls.spawns).toHaveLength(0);
  });

  it("multiAgent translates to codex -c flags and keeps hooks enabled", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done", finalResult: "ok" }]);
    await runAgentCall(deps, { repo: "/repo" }, "p", { multiAgent: { maxThreads: 4 } });
    const spawn = calls.spawns[0];
    expect(spawn.codexConfig).toEqual(["features.multi_agent=true", "agents.max_depth=1", "agents.max_threads=4"]);
    expect(spawn.disableHooks).toBe(false);
  });

  it("multiAgent with a csv adds spawn_agents_on_csv (terminating variant)", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done", finalResult: "ok" }]);
    await runAgentCall(deps, { repo: "/repo" }, "p", { multiAgent: { maxThreads: 2, csv: "a,b,c" } });
    expect(calls.spawns[0].codexConfig).toContain('agents.spawn_agents_on_csv="a,b,c"');
  });

  it("rejects multiAgent on a non-codex engine and a bad maxThreads", async () => {
    const { deps, calls } = makeFakeDeps([{ status: "done" }]);
    await expect(
      runAgentCall(deps, { repo: "/repo" }, "p", { engine: "cursor", multiAgent: { maxThreads: 2 } }),
    ).rejects.toThrow(/codex-engine-only/);
    await expect(
      runAgentCall(deps, { repo: "/repo" }, "p", { multiAgent: { maxThreads: 0 } }),
    ).rejects.toThrow(/positive integer/);
    expect(calls.spawns).toHaveLength(0);
  });
});
