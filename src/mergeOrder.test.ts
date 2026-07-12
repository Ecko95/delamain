import { describe, expect, it } from "vitest";
import { validateMergeOrder } from "./mergeOrder.js";
import type { PeerRecord } from "./types.js";

function peer(id: string, integrationStatus: PeerRecord["integrationStatus"], dependsOn?: string[]): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    logPath: "/tmp/x.log",
    integrationStatus,
    dependsOn,
  } as PeerRecord;
}

describe("validateMergeOrder", () => {
  const merged = peer("aaa", "merged");
  const pushed = peer("bbb", "pushed");

  it("passes when all dependencies are merged", () => {
    const c = peer("ccc", "pushed", ["aaa"]);
    expect(validateMergeOrder(c, [merged, pushed, c])).toEqual({ ok: true, blockers: [] });
  });

  it("blocks when a dependency is only pushed", () => {
    const c = peer("ccc", "pushed", ["bbb"]);
    const result = validateMergeOrder(c, [merged, pushed, c]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatchObject({ dep: "bbb", status: "pushed" });
  });

  it("blocks with status 'pending' when a dependency has no integrationStatus", () => {
    const d = peer("ddd", undefined);
    const c = peer("ccc", "pushed", ["ddd"]);
    const result = validateMergeOrder(c, [d, c]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatchObject({ dep: "ddd", status: "pending" });
  });

  it("blocks on missing dependencies", () => {
    const c = peer("ccc", "pushed", ["zzz"]);
    const result = validateMergeOrder(c, [c]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatchObject({ dep: "zzz", status: "missing" });
  });

  it("passes trivially without dependsOn", () => {
    const c = peer("ccc", "pushed");
    expect(validateMergeOrder(c, [c]).ok).toBe(true);
  });
});
