// src/workflow/pool.ts
//
// SP1 wave 2 — two-pool concurrency + termination guards (spec §5), enforced
// in the engine at the ONE choke point every leaf passes through: the agent
// semaphore. The workflow script never sees these brakes.
//
//   - Semaphore: caps how many leaf peers are ALIVE at once (the agent pool).
//     Script children stay oversubscribed; leaves are the heavy tenants.
//   - Guards (checked at the semaphore, never in the script):
//       maxAgents     — hard cap on TOTAL leaves spawned over the run
//       budgetTokens  — cumulative leaf tokens; stop when exhausted
//       (timeoutMs + script return live in engine.ts and also route halts here)
//     Tripping any guard halts the run and kills every live leaf.

import type { PeerRecord } from "../types.js";
import type { SlotToken } from "./ctx.js";

/** FIFO counting semaphore. acquire() resolves with a single-use release fn. */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  get capacity(): number {
    return this.max;
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.max) {
        grant();
      } else {
        this.queue.push(grant);
      }
    });
  }
}

export class WorkflowAbortedError extends Error {
  constructor(reason: string) {
    super(`workflow aborted: ${reason}`);
    this.name = "WorkflowAbortedError";
  }
}

export type RunGuards = {
  /** Max total leaves spawned over the run's life (hard cap → halt). */
  maxAgents?: number;
  /** Cumulative leaf tokens; run halts when spent reaches this. */
  budgetTokens?: number;
};

export type BudgetSnapshot = { total: number | null; spent: number; remaining: number };

export type RunControllerDeps = {
  /** Leaf token usage once terminal (input+output). 0 when unknown. */
  tokensForPeer: (peer: PeerRecord) => number;
  killPeer: (peerId: string) => void;
  log?: (line: string) => void;
};

/**
 * Owns the semaphore + guards for one workflow run. `acquire`/`release`/
 * `recordUsage` are handed to ctx.ts's runAgentCall as injected deps so the
 * spawn→wait→schema unit stays unchanged while every leaf is gated here.
 */
export class RunController {
  private readonly semaphore: Semaphore;
  private readonly guards: RunGuards;
  private readonly deps: RunControllerDeps;
  private readonly aliveLeaves = new Set<string>();

  private spawnedCount = 0;
  private spentTokens = 0;
  private peak = 0;
  private haltReasonValue: string | undefined;
  private onHaltCb: ((reason: string) => void) | undefined;

  constructor(opts: { maxConcurrency: number; guards: RunGuards; deps: RunControllerDeps }) {
    this.semaphore = new Semaphore(opts.maxConcurrency);
    this.guards = opts.guards;
    this.deps = opts.deps;
  }

  /** Engine registers the teardown that stops the sandbox child on halt. */
  onHalt(cb: (reason: string) => void): void {
    this.onHaltCb = cb;
  }

  get haltReason(): string | undefined {
    return this.haltReasonValue;
  }

  get spawned(): number {
    return this.spawnedCount;
  }

  get peakConcurrency(): number {
    return this.peak;
  }

  get liveCount(): number {
    return this.aliveLeaves.size;
  }

  budgetSnapshot(): BudgetSnapshot {
    const total = this.guards.budgetTokens ?? null;
    return {
      total,
      spent: this.spentTokens,
      remaining: total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - this.spentTokens),
    };
  }

  /** Halt the run once (idempotent): kill live leaves + stop the child. */
  halt(reason: string): void {
    if (this.haltReasonValue) return;
    this.haltReasonValue = reason;
    this.deps.log?.(`run halted: ${reason}`);
    this.killAllLeaves();
    this.onHaltCb?.(reason);
  }

  killAllLeaves(): void {
    for (const id of [...this.aliveLeaves]) {
      this.aliveLeaves.delete(id);
      try {
        this.deps.killPeer(id);
      } catch {
        /* already terminal */
      }
    }
  }

  /**
   * Called by runAgentCall BEFORE spawnPeer. Synchronously claims a leaf
   * against maxAgents/budget (so concurrent callers can't overshoot), then
   * awaits a semaphore slot. Throws WorkflowAbortedError if the run is (or
   * becomes) halted — that rejects this one agent() bridge call; hard-cap
   * trips additionally halt the whole run.
   */
  acquire = async (): Promise<SlotToken> => {
    if (this.haltReasonValue) {
      throw new WorkflowAbortedError(this.haltReasonValue);
    }
    // Synchronous guard + claim — no await between check and increment, so
    // concurrent callers can't overshoot maxAgents.
    if (this.guards.maxAgents !== undefined && this.spawnedCount >= this.guards.maxAgents) {
      this.halt(`maxAgents=${this.guards.maxAgents} reached`);
      throw new WorkflowAbortedError(this.haltReasonValue as string);
    }
    const budget = this.budgetSnapshot();
    if (budget.total !== null && budget.spent >= budget.total) {
      this.halt(`budgetTokens=${budget.total} exhausted (spent ${budget.spent})`);
      throw new WorkflowAbortedError(this.haltReasonValue as string);
    }
    this.spawnedCount += 1;

    const release = await this.semaphore.acquire();
    // A wall-clock timeout (or another agent's hard-cap trip) may have halted
    // the run while we queued; don't spawn into a dead run. Undo the claim so
    // maxAgents isn't charged for a leaf that never spawned.
    if (this.haltReasonValue) {
      release();
      this.spawnedCount -= 1;
      throw new WorkflowAbortedError(this.haltReasonValue);
    }
    // Return the slot's own release closure as the token. Each leaf holds its
    // OWN token (never a shared field), so concurrent leaves can't free each
    // other's slots — the wave-2 fan-out permit-leak fix.
    return release as SlotToken;
  };

  /** Frees exactly the slot acquire() returned. Called from runAgentCall's finally. */
  release = (token: SlotToken): void => {
    if (typeof token === "function") {
      (token as () => void)();
    }
  };

  /** Track a spawned leaf as alive (peak concurrency = max live at once). */
  markSpawned = (peer: PeerRecord): void => {
    this.aliveLeaves.add(peer.id);
    if (this.aliveLeaves.size > this.peak) {
      this.peak = this.aliveLeaves.size;
    }
  };

  /** Account a terminal leaf's tokens and drop it from the live set. */
  recordUsage = (peer: PeerRecord): void => {
    this.aliveLeaves.delete(peer.id);
    const tokens = this.deps.tokensForPeer(peer);
    if (tokens > 0) {
      this.spentTokens += tokens;
      this.deps.log?.(`leaf ${peer.id} spent ${tokens} tokens (run total ${this.spentTokens})`);
    }
    const budget = this.budgetSnapshot();
    if (budget.total !== null && budget.spent >= budget.total) {
      this.halt(`budgetTokens=${budget.total} exhausted (spent ${budget.spent})`);
    }
  };
}

/** DELAMAIN_MAX_AGENTS env → semaphore cap (small double-digit default). */
export function resolveMaxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DELAMAIN_MAX_AGENTS;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return 16;
}
