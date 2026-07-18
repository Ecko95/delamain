import { describe, expect, it } from "vitest";
import { ingestLine, mapEventToCommands, t3BridgeConfigFromEnv, type T3BridgeConfig } from "./t3Bridge.js";

function stubBridge() {
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization ?? null, body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const cfg: T3BridgeConfig = { baseUrl: "http://t3", token: "owner-tok", projectId: "proj-delamain", fetchImpl };
  return { cfg, calls };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("t3BridgeConfigFromEnv", () => {
  it("is disabled unless all three env vars are set", () => {
    expect(t3BridgeConfigFromEnv({})).toBeNull();
    expect(t3BridgeConfigFromEnv({ T3_BASE_URL: "x", T3_TOKEN: "y" })).toBeNull();
    const cfg = t3BridgeConfigFromEnv({ T3_BASE_URL: "http://t3/", T3_TOKEN: "y", T3_PROJECT_ID: "p" });
    expect(cfg).toEqual({ baseUrl: "http://t3", token: "y", projectId: "p" }); // trailing slash trimmed
  });
});

describe("mapEventToCommands", () => {
  const cfg: T3BridgeConfig = { baseUrl: "http://t3", token: "t", projectId: "proj-delamain" };

  it("workflow_start births a thread AND appends an activity", () => {
    const cmds = mapEventToCommands({ workflowId: "wf1", seq: 0, ts: "T", type: "workflow_start", name: "demo", scriptPath: "/s.ts" }, cfg);
    expect(cmds.map((c) => c.type)).toEqual(["thread.create", "thread.activity.append"]);
    const create: any = cmds[0];
    expect(create.threadId).toBe("thread-wf1");
    expect(create.projectId).toBe("proj-delamain");
    expect(create.title).toBe("demo");
    expect(create.runtimeMode).toBe("approval-required");
    expect(create.branch).toBeNull();
    expect(create.modelSelection).toEqual({ instanceId: "delamain", model: "workflow" });
  });

  it("workflow_start's two commands have DISTINCT deterministic commandIds (T3 dedupes by commandId)", () => {
    const ev = { workflowId: "wf1", seq: 1, ts: "T", type: "workflow_start", name: "demo" };
    const [create, activity]: any = mapEventToCommands(ev, cfg);
    expect(create.commandId).toBe("cmd-wf1-1");
    expect(activity.commandId).toBe("cmd-wf1-1-started");
    expect(activity.commandId).not.toBe(create.commandId); // else the info activity is dropped on ingest
    // deterministic across invocations → bridge restart re-read stays idempotent
    const [c2, a2]: any = mapEventToCommands(ev, cfg);
    expect(c2.commandId).toBe(create.commandId);
    expect(a2.commandId).toBe(activity.commandId);
  });

  it("agent_spawn -> task.started subagent activity (drives SubagentTaskSurface)", () => {
    const [a]: any = mapEventToCommands({ workflowId: "wf1", seq: 2, ts: "T", type: "agent_spawn", node: "leaf-1", engine: "pi", model: "gpt-5.4-mini" }, cfg);
    expect(a.type).toBe("thread.activity.append");
    expect(a.activity.kind).toBe("task.started");
    expect(a.activity.payload).toMatchObject({ taskType: "subagent", taskId: "leaf-1" });
    expect(a.commandId).toBe("cmd-wf1-2"); // deterministic per (workflowId,seq)
  });

  it("agent_failed -> task.completed with error tone", () => {
    const [a]: any = mapEventToCommands({ workflowId: "wf1", seq: 3, ts: "T", type: "agent_failed", node: "leaf-1", err: "boom" }, cfg);
    expect(a.activity.kind).toBe("task.completed");
    expect(a.activity.tone).toBe("error");
    expect(a.activity.payload).toMatchObject({ status: "failed", err: "boom" });
  });

  it("agent_progress and unknown types map to nothing", () => {
    expect(mapEventToCommands({ workflowId: "wf1", seq: 1, type: "agent_progress" }, cfg)).toEqual([]);
    expect(mapEventToCommands({ workflowId: "wf1", seq: 9, type: "phase_retry" }, cfg)).toEqual([]);
  });
});

describe("ingestLine (stub fetch)", () => {
  it("POSTs the mapped command sequence for a whole workflow", async () => {
    const { cfg, calls } = stubBridge();
    await ingestLine(cfg, line({ workflowId: "wf1", seq: 0, ts: "T", type: "workflow_start", name: "demo" }));
    await ingestLine(cfg, line({ workflowId: "wf1", seq: 1, ts: "T", type: "agent_spawn", node: "leaf-1", engine: "codex", model: "gpt-5.5" }));
    await ingestLine(cfg, line({ workflowId: "wf1", seq: 2, ts: "T", type: "agent_done", node: "leaf-1", status: "done", tokensSpent: 42 }));
    await ingestLine(cfg, line({ workflowId: "wf1", seq: 3, ts: "T", type: "workflow_end", status: "done" }));

    expect(calls.map((c) => c.body.type)).toEqual([
      "thread.create",
      "thread.activity.append", // workflow_start activity
      "thread.activity.append", // agent_spawn
      "thread.activity.append", // agent_done
      "thread.activity.append", // workflow_end
    ]);
    expect(calls[0].url).toBe("http://t3/api/delamain/ingest");
    expect(calls[0].auth).toBe("Bearer owner-tok");
    // all target the same deterministic thread
    expect(calls.every((c) => (c.body.threadId ?? c.body.threadId) === "thread-wf1")).toBe(true);
  });

  it("ignores blank/garbage lines without throwing", async () => {
    const { cfg, calls } = stubBridge();
    expect(await ingestLine(cfg, "")).toEqual([]);
    expect(await ingestLine(cfg, "not json")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
