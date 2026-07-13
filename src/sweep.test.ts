import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPeers } from "./sweep.js";
import { archivePath } from "./paths.js";
import { readState, writeState } from "./store.js";
import type { PeerRecord } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-12T00:00:00.000Z");

function peer(id: string, overrides: Partial<PeerRecord>): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: new Date(NOW - 30 * DAY).toISOString(),
    updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    logPath: "/tmp/x.log",
    ...overrides,
  } as PeerRecord;
}

describe("sweepPeers", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delamain-sweep-"));
    savedHome = process.env.DELAMAIN_HOME;
    process.env.DELAMAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DELAMAIN_HOME;
    else process.env.DELAMAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("archives terminal peers older than the cutoff and keeps the rest", () => {
    const old = peer("old00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    const fresh = peer("fresh000", { status: "done", finishedAt: new Date(NOW - 1 * DAY).toISOString() });
    const running = peer("run00000", { status: "working", updatedAt: new Date(NOW - 10 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [old, fresh, running] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.archived.map((p) => p.id)).toEqual(["old00000"]);
    expect(readState().peers.map((p) => p.id).sort()).toEqual(["fresh000", "run00000"]);
    const archive = JSON.parse(readFileSync(archivePath(), "utf8"));
    expect(archive.peers.map((p: PeerRecord) => p.id)).toEqual(["old00000"]);
  });

  it("marks dead-pid stale non-terminal peers failed (does not archive them yet)", () => {
    const zombie = peer("zomb0000", {
      status: "working",
      runnerPid: 999999999,
      lastHeartbeatAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [zombie] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.markedDead.map((p) => p.id)).toEqual(["zomb0000"]);
    const after = readState().peers[0];
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/swept/i);
  });

  it("dry-run changes nothing", () => {
    const old = peer("old00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [old] });
    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7, dryRun: true });
    expect(result.archived.map((p) => p.id)).toEqual(["old00000"]);
    expect(readState().peers).toHaveLength(1);
    expect(existsSync(archivePath())).toBe(false);
  });

  it("leaves waiting peers alone even with dead pids and a stale heartbeat", () => {
    const waiting = peer("wait0000", {
      status: "waiting",
      runnerPid: 999999999,
      lastHeartbeatAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [waiting] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.markedDead).toEqual([]);
    expect(readState().peers[0].status).toBe("waiting");
  });

  it("leaves gsd_phase_batch peers alone (no pids by design)", () => {
    const gsd = peer("gsd00000", {
      status: "working",
      kind: "gsd_phase_batch",
      lastHeartbeatAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [gsd] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.markedDead).toEqual([]);
    expect(readState().peers[0].status).toBe("working");
  });

  it("renames a corrupt archive aside and still writes the swept peers", () => {
    const old = peer("old00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [old] });
    writeFileSync(archivePath(), "not json", "utf8");

    sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    const archive = JSON.parse(readFileSync(archivePath(), "utf8"));
    expect(archive.peers.map((p: PeerRecord) => p.id)).toEqual(["old00000"]);
    const corrupt = readdirSync(home).filter((name) => name.startsWith("state.archive.json.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(home, corrupt[0]), "utf8")).toBe("not json");
  });

  it("appends to an existing archive instead of clobbering it", () => {
    const first = peer("one00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    const second = peer("two00000", { status: "killed", finishedAt: new Date(NOW - 9 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [first] });
    sweepPeers({ nowMs: NOW, olderThanDays: 7 });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [second] });
    sweepPeers({ nowMs: NOW, olderThanDays: 7 });
    const archive = JSON.parse(readFileSync(archivePath(), "utf8"));
    expect(archive.peers.map((p: PeerRecord) => p.id)).toEqual(["one00000", "two00000"]);
  });
});
