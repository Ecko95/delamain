import { describe, expect, it } from "vitest";
import type { PeerRecord } from "../types.js";
import { RunController, Semaphore, WorkflowAbortedError, resolveMaxConcurrency } from "./pool.js";

const leaf = (id: string): PeerRecord => ({
  id,
  repo: "/wt",
  task: "t",
  status: "done",
  startedAt: "t",
  updatedAt: "t",
  logPath: "/l",
});

describe("Semaphore", () => {
  it("caps concurrency and queues the rest FIFO", async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const task = async (n: number) => {
      const release = await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      active -= 1;
      release();
    };
    await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("a released slot lets exactly one waiter proceed", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let secondAcquired = false;
    const p = sem.acquire().then((r) => {
      secondAcquired = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(secondAcquired).toBe(false);
    r1();
    const r2 = await p;
    expect(secondAcquired).toBe(true);
    r2();
  });
});

describe("resolveMaxConcurrency", () => {
  it("reads DELAMAIN_MAX_AGENTS and defaults to 16", () => {
    expect(resolveMaxConcurrency({ DELAMAIN_MAX_AGENTS: "4" })).toBe(4);
    expect(resolveMaxConcurrency({})).toBe(16);
    expect(resolveMaxConcurrency({ DELAMAIN_MAX_AGENTS: "nonsense" })).toBe(16);
    expect(resolveMaxConcurrency({ DELAMAIN_MAX_AGENTS: "0" })).toBe(16);
  });
});

function makeController(opts: {
  maxConcurrency: number;
  maxAgents?: number;
  budgetTokens?: number;
  tokensForPeer?: (p: PeerRecord) => number;
}) {
  const killed: string[] = [];
  const halts: string[] = [];
  const controller = new RunController({
    maxConcurrency: opts.maxConcurrency,
    guards: { maxAgents: opts.maxAgents, budgetTokens: opts.budgetTokens },
    deps: {
      tokensForPeer: opts.tokensForPeer ?? (() => 0),
      killPeer: (id) => killed.push(id),
    },
  });
  controller.onHalt((reason) => halts.push(reason));
  return { controller, killed, halts };
}

// Simulate one gated leaf lifecycle: acquire → spawn → work → recordUsage/release.
async function runLeaf(controller: RunController, id: string, work: () => Promise<void>) {
  const slot = await controller.acquire();
  try {
    controller.markSpawned(leaf(id));
    await work();
  } finally {
    controller.recordUsage(leaf(id));
    controller.release(slot);
  }
}

describe("RunController guards", () => {
  it("never lets more than maxConcurrency leaves be alive at once", async () => {
    const { controller } = makeController({ maxConcurrency: 3 });
    let alive = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runLeaf(controller, `a${i}`, async () => {
          alive += 1;
          peak = Math.max(peak, alive);
          await new Promise((r) => setTimeout(r, 5));
          alive -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(controller.peakConcurrency).toBeLessThanOrEqual(3);
    expect(controller.spawned).toBe(12);
  });

  it("halts on maxAgents: the (cap+1)th acquire aborts and halts the run", async () => {
    const { controller, halts } = makeController({ maxConcurrency: 8, maxAgents: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => runLeaf(controller, `a${i}`, async () => {})),
    );
    const aborted = results.filter((r) => r.status === "rejected");
    expect(controller.haltReason).toMatch(/maxAgents=3/);
    expect(halts.some((h) => h.includes("maxAgents=3"))).toBe(true);
    expect(aborted.length).toBeGreaterThan(0);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(WorkflowAbortedError);
    }
    // At most 3 leaves were actually spawned.
    expect(controller.spawned).toBeLessThanOrEqual(3);
  });

  it("halts on budgetTokens once cumulative spend reaches the cap", async () => {
    const { controller, halts } = makeController({
      maxConcurrency: 1,
      budgetTokens: 100,
      tokensForPeer: () => 60,
    });
    await runLeaf(controller, "a0", async () => {}); // spends 60
    expect(controller.haltReason).toBeUndefined();
    await runLeaf(controller, "a1", async () => {}); // spends 60 → 120 ≥ 100 → halt
    expect(controller.budgetSnapshot().spent).toBe(120);
    expect(controller.haltReason).toMatch(/budgetTokens=100/);
    // A further acquire is refused.
    await expect(controller.acquire()).rejects.toBeInstanceOf(WorkflowAbortedError);
    expect(halts.some((h) => h.includes("budgetTokens=100"))).toBe(true);
  });

  it("budget snapshot is uncapped (Infinity remaining) when no budget set", () => {
    const { controller } = makeController({ maxConcurrency: 2 });
    const b = controller.budgetSnapshot();
    expect(b.total).toBeNull();
    expect(b.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it("release(token) frees exactly the acquired slot under interleaved acquire/release", async () => {
    // Regression for the wave-2 shared-pendingRelease bug: concurrent leaves
    // must each free their OWN slot, not whichever token was set last.
    const { controller } = makeController({ maxConcurrency: 2 });
    const t0 = await controller.acquire(); // active 1
    await controller.acquire(); // active 2 → full
    let third: unknown;
    let thirdResolved = false;
    const p3 = controller.acquire().then((t) => {
      thirdResolved = true;
      third = t;
      return t;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(thirdResolved).toBe(false); // queued behind the two live slots

    // Free the FIRST token (interleaved). Per-token release must let the queued
    // acquire proceed; a shared-field impl would leak/mismatch here.
    controller.release(t0);
    await p3;
    expect(thirdResolved).toBe(true);
    controller.release(third);

    // No permits leaked: a fresh acquire still resolves promptly.
    const again = await controller.acquire();
    expect(again).toBeTypeOf("function");
    controller.release(again);
  });

  it("halt() kills every live leaf and is idempotent", async () => {
    const { controller, killed } = makeController({ maxConcurrency: 4 });
    await controller.acquire();
    controller.markSpawned(leaf("x1"));
    await controller.acquire();
    controller.markSpawned(leaf("x2"));
    controller.halt("manual");
    controller.halt("again");
    expect(killed.sort()).toEqual(["x1", "x2"]);
    expect(controller.haltReason).toBe("manual");
  });
});
