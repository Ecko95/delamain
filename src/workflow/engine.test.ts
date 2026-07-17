import { describe, expect, it } from "vitest";
import type { PeerRecord } from "../types.js";
import { WorkflowTimeoutError, runWorkflowRun, type ScriptExecution, type WorkflowEngineDeps } from "./engine.js";
import type { WorkflowRunConfig } from "./types.js";

function makeRunRecord(workflowOverrides: Partial<WorkflowRunConfig> = {}): PeerRecord {
  return {
    id: "wf-1",
    repo: "/repo",
    task: "workflow",
    status: "starting",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/tmp/wf.log",
    kind: "workflow_run",
    workflow: {
      scriptPath: "/tmp/demo.ts",
      repo: "/repo",
      status: "pending",
      agentPeerIds: [],
      seed: 42,
      startTimeMs: 1_000_000,
      ...workflowOverrides,
    },
  };
}

type ExecutorImpl = (request: {
  onCall: (method: string, args: unknown[]) => Promise<unknown>;
  budgetTotal?: number | null;
  getBudgetSpent?: () => number;
}) => ScriptExecution;

function makeDeps(executor: ExecutorImpl) {
  const records = new Map<string, PeerRecord>();
  const killed: string[] = [];
  const logLines: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let leafCounter = 0;
  const deps: WorkflowEngineDeps = {
    spawnPeer: (options) => {
      leafCounter += 1;
      const leaf: PeerRecord = {
        id: `leaf-${leafCounter}`,
        repo: "/wt",
        task: options.prompt.slice(0, 40),
        status: "starting",
        startedAt: "t",
        updatedAt: "t",
        logPath: "/tmp/leaf.log",
      };
      return leaf;
    },
    waitForPeer: async ({ peerId }) => ({
      peer: {
        id: peerId,
        repo: "/wt",
        task: "t",
        status: "done",
        finalResult: '```json\n{"echo":"ok"}\n```',
        startedAt: "t",
        updatedAt: "t",
        logPath: "/tmp/leaf.log",
      },
      timedOut: false,
      elapsedMs: 1,
    }),
    resumePeer: () => {
      throw new Error("not used");
    },
    readAgentResultFile: () => undefined,
    removeAgentResultFile: () => {},
    updatePeer: (id, patch) => {
      const current = records.get(id) ?? makeRunRecord();
      const next = { ...current, ...patch, id };
      records.set(id, next);
      return next;
    },
    appendLog: async (_peer, line) => {
      logLines.push(line);
    },
    killPeer: (peerId) => {
      killed.push(peerId);
    },
    tokensForPeer: () => 0,
    readJournal: () => [],
    writeJournal: () => {},
    emitEvent: (_id, type, payload) => events.push({ type, payload }),
    executeScript: (request) => executor(request),
    now: () => Date.now(),
  };
  return { deps, records, killed, logLines, events };
}

describe("runWorkflowRun", () => {
  it("marks the run done with the script's return value", async () => {
    const { deps, records } = makeDeps(() => ({
      result: Promise.resolve({ topRisk: "state races", severity: "high" }),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("done");
    expect(final.workflow?.status).toBe("done");
    expect(final.workflow?.result).toEqual({ topRisk: "state races", severity: "high" });
    expect(records.get("wf-1")?.finishedAt).toBeTruthy();
  });

  it("emits the workflow_start → phase_start → agent_spawn/agent_done → workflow_end event stream", async () => {
    const { deps, events } = makeDeps(({ onCall }) => ({
      result: (async () => {
        await onCall("agent", ["do a thing", { schema: { type: "object" }, phase: "review" }, 0]);
        return { ok: true };
      })(),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("done");
    const types = events.map((e) => e.type);
    expect(types).toEqual(["workflow_start", "phase_start", "agent_spawn", "agent_done", "workflow_end"]);
    expect(events.find((e) => e.type === "phase_start")?.payload.phase).toBe("review");
    expect(events.find((e) => e.type === "agent_spawn")?.payload.node).toBe("leaf-1");
    expect(events.find((e) => e.type === "workflow_end")?.payload.status).toBe("done");
  });

  it("emits agent_failed and a halted/failed workflow_end when the script throws", async () => {
    const { deps, events } = makeDeps(() => ({
      result: Promise.reject(new Error("boom")),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("failed");
    const end = events.find((e) => e.type === "workflow_end");
    expect(end?.payload.status).toBe("failed");
  });

  it("routes ctx.agent bridge calls through the peer deps and records leaf ids", async () => {
    const { deps } = makeDeps(({ onCall }) => ({
      result: (async () => {
        const first = await onCall("agent", ["do a thing", { schema: { type: "object" } }]);
        await onCall("log", ["halfway"]);
        return { first };
      })(),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("done");
    expect(final.workflow?.agentPeerIds).toEqual(["leaf-1"]);
    expect(final.workflow?.result).toEqual({ first: { echo: "ok" } });
  });

  it("halts on timeoutMs, kills the child and any still-alive leaf peers", async () => {
    let killedChild = 0;
    const { deps, killed } = makeDeps(({ onCall }) => ({
      result: (async () => {
        // A leaf whose wait never resolves stays alive when the timeout fires.
        await onCall("agent", ["spawn one leaf"]);
      })(),
      kill: () => {
        killedChild += 1;
      },
    }));
    // Make the leaf hang so it is still alive at timeout.
    deps.waitForPeer = () => new Promise(() => {});
    const final = await runWorkflowRun(makeRunRecord({ timeoutMs: 50 }), deps);
    expect(final.status).toBe("halted");
    expect(final.workflow?.status).toBe("halted");
    expect(final.error).toMatch(/timeoutMs=50/);
    expect(killedChild).toBeGreaterThan(0);
    expect(killed).toEqual(["leaf-1"]);
  });

  it("marks the run failed when the script throws", async () => {
    const { deps } = makeDeps(() => ({
      result: Promise.reject(new Error("boom in script")),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("failed");
    expect(final.workflow?.status).toBe("failed");
    expect(final.error).toContain("boom in script");
  });

  it("rejects unknown ctx methods over the bridge", async () => {
    const { deps } = makeDeps(({ onCall }) => ({
      result: onCall("fetch", ["https://example.com"]),
      kill: () => {},
    }));
    const final = await runWorkflowRun(makeRunRecord(), deps);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("unknown ctx method");
  });

  it("refuses non-workflow records", async () => {
    const { deps } = makeDeps(() => ({ result: Promise.resolve(1), kill: () => {} }));
    const generic = { ...makeRunRecord(), kind: "generic" as const, workflow: undefined };
    await expect(runWorkflowRun(generic, deps)).rejects.toThrow(/not a workflow_run record/);
  });

  it("WorkflowTimeoutError carries the configured budget", () => {
    expect(new WorkflowTimeoutError(1234).message).toContain("1234");
  });
});

describe("runWorkflowRun — two-pool concurrency + guards", () => {
  // A deps factory whose waitForPeer resolves after a delay so overlapping
  // ctx.agent calls exercise the semaphore. Tracks peak in-flight leaves.
  function makeConcurrencyDeps(opts: { waitMs: number; tokens?: number }) {
    let inFlight = 0;
    let peak = 0;
    let spawnCounter = 0;
    const records = new Map<string, PeerRecord>();
    const deps: WorkflowEngineDeps = {
      spawnPeer: () => {
        spawnCounter += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return {
          id: `leaf-${spawnCounter}`,
          repo: "/wt",
          task: "t",
          status: "starting",
          startedAt: "t",
          updatedAt: "t",
          logPath: "/l",
        };
      },
      waitForPeer: async ({ peerId }) => {
        await new Promise((r) => setTimeout(r, opts.waitMs));
        inFlight -= 1;
        return {
          peer: {
            id: peerId,
            repo: "/wt",
            task: "t",
            status: "done",
            finalResult: "ok",
            startedAt: "t",
            updatedAt: "t",
            logPath: "/l",
          },
          timedOut: false,
          elapsedMs: opts.waitMs,
        };
      },
      resumePeer: () => {
        throw new Error("unused");
      },
      readAgentResultFile: () => undefined,
      removeAgentResultFile: () => {},
      updatePeer: (id, patch) => {
        const current = records.get(id) ?? makeRunRecord();
        const next = { ...current, ...patch, id };
        records.set(id, next);
        return next;
      },
      appendLog: async () => {},
      killPeer: () => {},
      tokensForPeer: () => opts.tokens ?? 0,
      readJournal: () => [],
      writeJournal: () => {},
      executeScript: () => ({ result: Promise.resolve(null), kill: () => {} }),
      now: () => Date.now(),
    };
    return { deps, peak: () => peak, spawned: () => spawnCounter };
  }

  it("caps concurrent leaves at maxConcurrency even when the script fans out wide", async () => {
    const { deps, peak } = makeConcurrencyDeps({ waitMs: 15 });
    const runner = {
      ...deps,
      executeScript: ({ onCall }: { onCall: (m: string, a: unknown[]) => Promise<unknown> }) => ({
        result: Promise.all(Array.from({ length: 10 }, () => onCall("agent", ["go"]))),
        kill: () => {},
      }),
    } as WorkflowEngineDeps;
    const final = await runWorkflowRun(makeRunRecord(), runner, { maxConcurrency: 3 });
    expect(final.status).toBe("done");
    expect(peak()).toBeLessThanOrEqual(3);
  });

  it("halts on maxAgents (total leaves), killing the child", async () => {
    const { deps, spawned } = makeConcurrencyDeps({ waitMs: 2 });
    let childKilled = false;
    const runner = {
      ...deps,
      executeScript: ({ onCall }: { onCall: (m: string, a: unknown[]) => Promise<unknown> }) => ({
        // 8 agents requested; cap the total at 4.
        result: Promise.allSettled(Array.from({ length: 8 }, () => onCall("agent", ["go"]))).then(() =>
          // keep the "script" alive until the child is killed
          new Promise(() => {}),
        ),
        kill: () => {
          childKilled = true;
        },
      }),
    } as WorkflowEngineDeps;
    const final = await runWorkflowRun(makeRunRecord({ maxAgents: 4 }), runner, { maxConcurrency: 8 });
    expect(final.status).toBe("halted");
    expect(final.error).toMatch(/maxAgents=4/);
    expect(spawned()).toBeLessThanOrEqual(4);
    expect(childKilled).toBe(true);
  });

  it("halts on budgetTokens once cumulative leaf tokens exhaust the budget", async () => {
    const { deps } = makeConcurrencyDeps({ waitMs: 2, tokens: 40 });
    const runner = {
      ...deps,
      executeScript: ({ onCall }: { onCall: (m: string, a: unknown[]) => Promise<unknown> }) => ({
        result: (async () => {
          // Serial agents, each spending 40 tokens; budget 100 → halts by #3.
          for (let i = 0; i < 10; i += 1) {
            await onCall("agent", ["go"]).catch(() => null);
          }
          await new Promise(() => {});
        })(),
        kill: () => {},
      }),
    } as WorkflowEngineDeps;
    const final = await runWorkflowRun(makeRunRecord({ budgetTokens: 100 }), runner, { maxConcurrency: 1 });
    expect(final.status).toBe("halted");
    expect(final.error).toMatch(/budgetTokens=100/);
    expect(final.workflow?.tokensSpent).toBeGreaterThanOrEqual(100);
  });

  it("exposes live budget spend to the child via getBudgetSpent", async () => {
    const { deps } = makeConcurrencyDeps({ waitMs: 1, tokens: 25 });
    let sampled = -1;
    const runner = {
      ...deps,
      executeScript: (req: { onCall: (m: string, a: unknown[]) => Promise<unknown>; getBudgetSpent: () => number }) => ({
        result: (async () => {
          await req.onCall("agent", ["one"]);
          await req.onCall("agent", ["two"]);
          sampled = req.getBudgetSpent();
          return { spent: sampled };
        })(),
        kill: () => {},
      }),
    } as unknown as WorkflowEngineDeps;
    const final = await runWorkflowRun(makeRunRecord({ budgetTokens: 1000 }), runner, { maxConcurrency: 2 });
    expect(final.status).toBe("done");
    expect(sampled).toBe(50);
  });
});

describe("runWorkflowRun — journaling + resume replay", () => {
  const SCHEMA = { type: "object" };

  // Deps with an in-memory journal; each live leaf returns a result echoing its
  // prompt so replayed (journaled) vs live results are distinguishable.
  function makeJournalDeps() {
    const journal: any[] = [];
    const prompts = new Map<string, string>();
    const spawns: string[] = [];
    let n = 0;
    const deps: WorkflowEngineDeps = {
      spawnPeer: (o) => {
        n += 1;
        const id = `leaf-${n}`;
        prompts.set(id, o.prompt);
        spawns.push(o.prompt.split("\n")[0]); // original prompt (schema instr is appended after)
        return { id, repo: "/wt", task: "t", status: "starting", startedAt: "t", updatedAt: "t", logPath: "/l" };
      },
      waitForPeer: async ({ peerId }) => ({
        peer: {
          id: peerId as string,
          repo: "/wt",
          task: "t",
          status: "done",
          finalResult: `\`\`\`json\n${JSON.stringify({ v: `live:${peerId}` })}\n\`\`\``,
          startedAt: "t",
          updatedAt: "t",
          logPath: "/l",
        },
        timedOut: false,
        elapsedMs: 1,
      }),
      resumePeer: () => {
        throw new Error("unused");
      },
      readAgentResultFile: () => undefined,
      removeAgentResultFile: () => {},
      updatePeer: (_id, patch) => ({ ...makeRunRecord(), ...patch, id: "wf-1" }) as PeerRecord,
      appendLog: async () => {},
      killPeer: () => {},
      tokensForPeer: () => 0,
      readJournal: () => journal.map((r) => ({ ...r })),
      writeJournal: (row) => {
        const i = journal.findIndex((r) => r.callIndex === row.callIndex);
        if (i >= 0) journal[i] = { ...row };
        else journal.push({ ...row });
      },
      executeScript: () => ({ result: Promise.resolve(null), kill: () => {} }),
      now: () => Date.now(),
    };
    return { deps, journal, spawns };
  }

  // A script that issues the given agent calls in order (index = position).
  function scriptExec(calls: Array<{ prompt: string }>) {
    return (req: { onCall: (m: string, a: unknown[]) => Promise<unknown> }) => ({
      result: (async () => {
        const out: unknown[] = [];
        for (let i = 0; i < calls.length; i += 1) {
          out.push(await req.onCall("agent", [calls[i].prompt, { schema: SCHEMA }, i]));
        }
        return out;
      })(),
      kill: () => {},
    });
  }

  it("a fresh run journals every agent call", async () => {
    const { deps, journal, spawns } = makeJournalDeps();
    const runner = { ...deps, executeScript: scriptExec([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }]) } as WorkflowEngineDeps;
    const final = await runWorkflowRun(makeRunRecord(), runner);
    expect(final.status).toBe("done");
    expect(spawns).toEqual(["a", "b", "c"]);
    expect(journal.map((r) => r.callIndex)).toEqual([0, 1, 2]);
    expect(final.workflow?.replayedAgents).toBe(0);
  });

  it("resuming an identical completed run replays 100% from the journal (zero spawns)", async () => {
    const first = makeJournalDeps();
    const script = scriptExec([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }]);
    await runWorkflowRun(makeRunRecord(), { ...first.deps, executeScript: script } as WorkflowEngineDeps);
    expect(first.spawns.length).toBe(3);

    // Resume: reuse the SAME journal, fresh spawn tracking.
    const second = makeJournalDeps();
    second.journal.push(...first.journal);
    const final = await runWorkflowRun(makeRunRecord(), { ...second.deps, executeScript: script } as WorkflowEngineDeps);
    expect(second.spawns).toEqual([]); // nothing re-spawned
    expect(final.workflow?.replayedAgents).toBe(3);
    // Replayed results are the journaled ones.
    expect(final.workflow?.result).toEqual([{ v: "live:leaf-1" }, { v: "live:leaf-2" }, { v: "live:leaf-3" }]);
  });

  it("resumes from the longest unchanged prefix: replays before divergence, runs the rest live", async () => {
    // Journal a 3-call run.
    const first = makeJournalDeps();
    await runWorkflowRun(
      makeRunRecord(),
      { ...first.deps, executeScript: scriptExec([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }]) } as WorkflowEngineDeps,
    );

    // Resume with call 1's prompt CHANGED → divergence at index 1; calls 1 and 2
    // run live even though call 2's prompt is unchanged (state after 1 differs).
    const second = makeJournalDeps();
    second.journal.push(...first.journal);
    const final = await runWorkflowRun(
      makeRunRecord(),
      { ...second.deps, executeScript: scriptExec([{ prompt: "a" }, { prompt: "b-CHANGED" }, { prompt: "c" }]) } as WorkflowEngineDeps,
    );
    expect(final.workflow?.replayedAgents).toBe(1); // only call 0
    expect(second.spawns).toEqual(["b-CHANGED", "c"]); // 1 and 2 ran live
    // Journal now reflects the new run at indices 1 and 2.
    expect(second.journal.find((r) => r.callIndex === 1).promptHash).not.toEqual(first.journal[1].promptHash);
  });

  it("a killed run (partial journal) resumes: completed prefix replays, the rest runs live", async () => {
    // Simulate a kill after 2 of 4 calls by journaling only indices 0,1.
    const partial = makeJournalDeps();
    await runWorkflowRun(
      makeRunRecord(),
      { ...partial.deps, executeScript: scriptExec([{ prompt: "a" }, { prompt: "b" }]) } as WorkflowEngineDeps,
    );
    expect(partial.journal.map((r) => r.callIndex)).toEqual([0, 1]);

    // Resume the full 4-call script; 0,1 replay, 2,3 run live.
    const resumed = makeJournalDeps();
    resumed.journal.push(...partial.journal);
    const final = await runWorkflowRun(
      makeRunRecord(),
      {
        ...resumed.deps,
        executeScript: scriptExec([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d" }]),
      } as WorkflowEngineDeps,
    );
    expect(final.workflow?.replayedAgents).toBe(2);
    expect(resumed.spawns).toEqual(["c", "d"]);
    expect(resumed.journal.map((r) => r.callIndex).sort()).toEqual([0, 1, 2, 3]);
  });
});
