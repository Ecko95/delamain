import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTerminalWaitStatus, runWaitCommand } from "./wait.js";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "delamain-wait-"));
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

describe("wait command", () => {
  it("treats waiting as terminal", async () => {
    expect(isTerminalWaitStatus("waiting")).toBe(true);
    expect(isTerminalWaitStatus("working")).toBe(false);
    await writeState([
      peer("p1", "waiting", "needs reply"),
      peer("p2", "done", "finished"),
    ]);
    const lines: string[] = [];

    const code = await runWaitCommand(["p1", "p2"], {
      intervalMs: 1,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith("p"))).toEqual([
      "p1\tPeer p1\twaiting\tneeds reply",
      "p2\tPeer p2\tdone\tfinished",
    ]);
  });

  it("exits with --any when the first watched peer is terminal", async () => {
    await writeState([
      peer("p1", "working", "still running"),
      peer("p2", "failed", "failed"),
    ]);
    const lines: string[] = [];

    const code = await runWaitCommand(["p1", "p2"], {
      any: true,
      intervalMs: 1,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines).toContain("p1\tPeer p1\tworking\tstill running");
    expect(lines).toContain("p2\tPeer p2\tfailed\tfailed");
  });

  it("returns exit code 2 on timeout with current statuses", async () => {
    await writeState([peer("p1", "working", "still running")]);
    const lines: string[] = [];

    const code = await runWaitCommand(["p1"], {
      intervalMs: 1,
      timeoutMs: 5,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(2);
    expect(lines).toContain("p1\tPeer p1\tworking\tstill running");
  });
});

async function writeState(peers: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(
    join(root, "state.json"),
    JSON.stringify({ version: 1, updatedAt: "2026-07-06T00:00:00.000Z", peers }, null, 2),
    "utf8",
  );
}

function peer(id: string, status: string, lastEvent: string): Record<string, unknown> {
  return {
    id,
    name: `Peer ${id}`,
    repo: process.cwd(),
    task: "wait test",
    status,
    startedAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    logPath: join(root, `${id}.log`),
    lastEvent,
  };
}
