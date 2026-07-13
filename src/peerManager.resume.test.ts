import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumePeer } from "./peerManager.js";
import { getPeer, writeState } from "./store.js";
import type { PeerRecord } from "./types.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 4242,
    unref: vi.fn(),
  })),
}));

function peer(id: string, overrides: Partial<PeerRecord>): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "t",
    status: "done",
    threadId: "thread-1",
    startedAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    logPath: "/tmp/x.log",
    ...overrides,
  } as PeerRecord;
}

describe("resumePeer", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delamain-resume-"));
    savedHome = process.env.DELAMAIN_HOME;
    process.env.DELAMAIN_HOME = home;
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DELAMAIN_HOME;
    else process.env.DELAMAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("clears stale integration fields while keeping dependencies and claims", () => {
    const before = peer("peer0001", {
      status: "done",
      question: "continue?",
      finishedAt: "2026-07-12T01:00:00.000Z",
      exitCode: 0,
      signal: null,
      integrationStatus: "merged",
      integrationError: "old error",
      integrationCommitSha: "abc123",
      integrationMergeCommitSha: "def456",
      integrationPrNumber: 17,
      integrationPrUrl: "https://example.test/pr/17",
      dependsOn: ["base0001"],
      claims: ["src/peerManager.ts"],
    });
    writeState({ version: 1, updatedAt: "2026-07-12T00:00:00.000Z", peers: [before] });

    const resumed = resumePeer({ peerId: "peer0001", prompt: "continue work" });
    const stored = getPeer("peer0001");

    expect(spawn).toHaveBeenCalledOnce();
    expect(resumed.status).toBe("starting");
    expect(resumed.runnerPid).toBe(4242);
    expect(stored?.question).toBeUndefined();
    expect(stored?.finishedAt).toBeUndefined();
    expect(stored?.exitCode).toBeUndefined();
    expect(stored?.signal).toBeUndefined();
    expect(stored?.integrationStatus).toBeUndefined();
    expect(stored?.integrationError).toBeUndefined();
    expect(stored?.integrationCommitSha).toBeUndefined();
    expect(stored?.integrationMergeCommitSha).toBeUndefined();
    expect(stored?.integrationPrNumber).toBeUndefined();
    expect(stored?.integrationPrUrl).toBeUndefined();
    expect(stored?.dependsOn).toEqual(["base0001"]);
    expect(stored?.claims).toEqual(["src/peerManager.ts"]);
  });
});
