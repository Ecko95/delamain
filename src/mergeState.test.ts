import { describe, expect, it } from "vitest";
import { applyPrState, type PrView } from "./mergeState.js";
import type { PeerRecord } from "./types.js";

function pushedPeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    id: "abc12345",
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    logPath: "/tmp/x.log",
    integrationStatus: "pushed",
    integrationPrNumber: 12,
    ...overrides,
  } as PeerRecord;
}

describe("applyPrState", () => {
  it("marks MERGED PRs merged and records the merge sha", () => {
    const pr: PrView = { state: "MERGED", mergeCommit: { oid: "deadbeef" } };
    const next = applyPrState(pushedPeer(), pr);
    expect(next?.integrationStatus).toBe("merged");
    expect(next?.integrationMergeCommitSha).toBe("deadbeef");
  });

  it("returns undefined (no change) while the PR is still OPEN", () => {
    expect(applyPrState(pushedPeer(), { state: "OPEN" })).toBeUndefined();
  });

  it("records closed-without-merge as integrationError, status stays pushed", () => {
    const next = applyPrState(pushedPeer(), { state: "CLOSED" });
    expect(next?.integrationStatus).toBe("pushed");
    expect(next?.integrationError).toMatch(/closed without merge/i);
  });

  it("ignores peers that are not pushed or have no PR number", () => {
    expect(applyPrState(pushedPeer({ integrationStatus: "pending" }), { state: "MERGED" })).toBeUndefined();
    expect(applyPrState(pushedPeer({ integrationPrNumber: undefined }), { state: "MERGED" })).toBeUndefined();
  });
});
