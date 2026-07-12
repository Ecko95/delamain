import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPrState, refreshAllMergeStates, type PrView } from "./mergeState.js";
import { getPeer } from "./store.js";
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

describe("refreshAllMergeStates", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "delamain-merge-"));
    previousHome = process.env.DELAMAIN_HOME;
    process.env.DELAMAIN_HOME = root;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.DELAMAIN_HOME;
    } else {
      process.env.DELAMAIN_HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function seed(peers: PeerRecord[]): Promise<void> {
    // Pre-fill worktree fields so listPeers' reconciliation doesn't spawn git
    // against the fake repo path.
    const enriched = peers.map((peer) => ({
      ...peer,
      worktreePath: root,
      gitDir: join(root, ".git"),
      gitCommonDir: join(root, ".git"),
      isLinkedWorktree: false,
    }));
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({ version: 1, updatedAt: "2026-07-01T00:00:00.000Z", peers: enriched }, null, 2),
      "utf8",
    );
  }

  it("refreshes only pushed-with-PR peers and persists the merged status", async () => {
    await seed([
      pushedPeer({ id: "eligible1" }),
      pushedPeer({ id: "pending1", integrationStatus: "pending" }),
      pushedPeer({ id: "nopr1", integrationPrNumber: undefined }),
    ]);
    const changed = refreshAllMergeStates(() => ({ state: "MERGED", mergeCommit: { oid: "deadbeef" } }));
    expect(changed.map((peer) => peer.id)).toEqual(["eligible1"]);
    expect(changed[0]?.integrationStatus).toBe("merged");
    expect(getPeer("eligible1")?.integrationStatus).toBe("merged");
    expect(getPeer("eligible1")?.integrationMergeCommitSha).toBe("deadbeef");
    expect(getPeer("pending1")?.integrationStatus).toBe("pending");
    expect(getPeer("nopr1")?.integrationStatus).toBe("pushed");
  });

  it("leaves state untouched when the view fn throws", async () => {
    await seed([pushedPeer({ id: "eligible1" })]);
    const changed = refreshAllMergeStates(() => {
      throw new Error("gh not installed");
    });
    expect(changed).toEqual([]);
    expect(getPeer("eligible1")?.integrationStatus).toBe("pushed");
    expect(getPeer("eligible1")?.integrationError).toBeUndefined();
  });
});
