import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killWorkflowRun } from "./manager.js";
import { getPeer, readWorkflowEvents, upsertPeer } from "../store.js";
import type { PeerRecord } from "../types.js";

function workflowPeer(id: string, agentPeerIds: string[]): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "wf",
    kind: "workflow_run",
    status: "working",
    threadId: "t",
    startedAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    logPath: "/tmp/x.log",
    runnerPid: process.pid, // alive; injected killPid spy means no real signal fires
    workflow: {
      scriptPath: "/s.ts",
      repo: "/tmp/x",
      status: "running",
      agentPeerIds,
      seed: 1,
      startTimeMs: 0,
    },
  } as PeerRecord;
}

function agentPeer(id: string, status: PeerRecord["status"]): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "leaf",
    status,
    threadId: "t",
    startedAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    logPath: "/tmp/x.log",
  } as PeerRecord;
}

describe("killWorkflowRun (contract 2)", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delamain-kill-"));
    savedHome = process.env.DELAMAIN_HOME;
    process.env.DELAMAIN_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.DELAMAIN_HOME;
    else process.env.DELAMAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("kills the runner + live leaves, persists killed, emits workflow_end", () => {
    upsertPeer(workflowPeer("wf1", ["leaf-live", "leaf-done"]));
    upsertPeer(agentPeer("leaf-live", "working"));
    upsertPeer(agentPeer("leaf-done", "done")); // already terminal -> skipped

    const killPid = vi.fn(() => true);
    const killPeer = vi.fn();
    const res = killWorkflowRun("wf1", { killPid, killPeer });

    expect(res).toEqual({ workflowId: "wf1", status: "killed", peersKilled: ["leaf-live"] });
    // runner SIGTERM'd, only the live leaf killed.
    expect(killPid).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(killPeer).toHaveBeenCalledTimes(1);
    expect(killPeer).toHaveBeenCalledWith("leaf-live", "SIGTERM");

    // store transitioned to terminal.
    expect(getPeer("wf1")!.status).toBe("killed");

    // durable workflow_end appended (what the T3 mirror tails).
    const events = readWorkflowEvents("wf1");
    const end = events.find((e) => e.type === "workflow_end");
    expect(end).toBeTruthy();
    expect((end!.payload as any).status).toBe("killed");
  });

  it("is idempotent: an already-terminal workflow kills nothing", () => {
    upsertPeer({ ...workflowPeer("wf2", []), status: "done" } as PeerRecord);
    const killPid = vi.fn(() => true);
    const killPeer = vi.fn();
    const res = killWorkflowRun("wf2", { killPid, killPeer });

    expect(res).toEqual({ workflowId: "wf2", status: "done", peersKilled: [] });
    expect(killPid).not.toHaveBeenCalled();
    expect(killPeer).not.toHaveBeenCalled();
  });
});
