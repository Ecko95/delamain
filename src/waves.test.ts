import { describe, expect, it } from "vitest";
import { wavesView } from "./waves.js";
import type { PeerRecord } from "./types.js";

function peer(id: string, over: Partial<PeerRecord>): PeerRecord {
  return { id, repo: "/tmp/x", task: `task ${id}`, status: "working", startedAt: "", updatedAt: "", logPath: "", ...over } as PeerRecord;
}

describe("wavesView", () => {
  it("buckets peers into running / awaiting-integration / merge-ready / merge-blocked / merged", () => {
    const a = peer("aaa", { status: "done", integrationStatus: "merged" });
    const b = peer("bbb", { status: "done", integrationStatus: "pushed" }); // no deps: merge-ready
    const c = peer("ccc", { status: "done", integrationStatus: "pushed", dependsOn: ["bbb"] }); // blocked on bbb
    const d = peer("ddd", { status: "working" });
    const e = peer("eee", { status: "done", integrationStatus: "pending" });

    const view = wavesView([a, b, c, d, e]);

    expect(view.running.map((p) => p.id)).toEqual(["ddd"]);
    expect(view.awaitingIntegration.map((p) => p.id)).toEqual(["eee"]);
    expect(view.mergeReady.map((p) => p.id)).toEqual(["bbb"]);
    expect(view.mergeBlocked.map((x) => x.peer.id)).toEqual(["ccc"]);
    expect(view.mergeBlocked[0].blockers[0].dep).toBe("bbb");
    expect(view.merged.map((p) => p.id)).toEqual(["aaa"]);
  });

  it("reports claim conflicts among running peers", () => {
    const p1 = peer("aaa", { claims: ["src/api"] });
    const p2 = peer("bbb", { claims: ["src/api/users"] });
    const view = wavesView([p1, p2]);
    expect(view.claimConflicts).toHaveLength(1);
    expect(view.claimConflicts[0]).toMatchObject({ a: "aaa", b: "bbb" });
  });
});
