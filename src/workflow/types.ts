// src/workflow/types.ts
//
// SP1 wave 1 — code-defined workflow engine types. A workflow script is a
// TS/JS module of the shape:
//
//   export const meta = { name, description };
//   export default async function run(ctx) { ... }
//
// The script runs inside the sandbox child (sandbox-child.ts); `ctx` is the
// ONLY capability it has. Wave 1 implements ctx.agent + ctx.log only.

import type { PeerRecord } from "../types.js";

export type WorkflowMeta = {
  name: string;
  description?: string;
};

/** Options accepted by ctx.agent(prompt, opts). Wave 1: codex engine only. */
export type WorkflowAgentOpts = {
  engine?: "codex";
  model?: string;
  /** JSON Schema the agent's structured result must validate against. */
  schema?: Record<string, unknown>;
  /** Display name for the spawned leaf peer. */
  label?: string;
  /** Progress-group label (defaults to the current ctx.phase()). */
  phase?: string;
};

/** Token budget view exposed to the script (SP1 wave 2). */
export type WorkflowBudget = {
  /** budgetTokens for the run, or null when uncapped. */
  total: number | null;
  /** Tokens spent by finished leaves so far. */
  spent(): number;
  /** total - spent (Infinity when uncapped). */
  remaining(): number;
};

/** A unit of work for ctx.parallel — a thunk returning a promise. */
export type WorkflowThunk = () => Promise<unknown>;

/** A ctx.pipeline stage: receives (prev, originalItem, index). */
export type WorkflowStage = (prev: unknown, item: unknown, index: number) => Promise<unknown> | unknown;

/** The capability surface injected into the sandboxed script. */
export type WorkflowCtx = {
  /**
   * Spawn ONE leaf peer (own worktree, integrate:false), wait for it, and
   * return its result — a string, or a schema-validated object when
   * opts.schema is present. Throws after the bounded schema-retry budget or
   * when the peer dies.
   */
  agent(prompt: string, opts?: WorkflowAgentOpts): Promise<unknown>;
  /**
   * Barrier fan-out: run all thunks concurrently under the agent semaphore,
   * await every one. A throwing thunk resolves to null (never rejects), so
   * filter with .filter(Boolean).
   */
  parallel(thunks: WorkflowThunk[]): Promise<unknown[]>;
  /**
   * No-barrier streaming: each item flows through every stage independently
   * (item A can be at stage 3 while B is still at stage 1). A stage throw
   * drops that item to null and skips its remaining stages.
   */
  pipeline(items: unknown[], ...stages: WorkflowStage[]): Promise<unknown[]>;
  /** Set the current progress-group label applied to subsequent agents. */
  phase(title: string): void;
  /** Narrator line appended to the run log. */
  log(message: string): void;
  /** Token budget for the run (SP1 wave 2). */
  budget: WorkflowBudget;
};

export type WorkflowSpec = {
  meta: WorkflowMeta;
  run: (ctx: WorkflowCtx) => Promise<unknown>;
};

/** Workflow-level status carried inside the workflow_run PeerRecord. */
export type WorkflowStatus = "pending" | "running" | "done" | "failed" | "halted";

/**
 * Config + progress blob for a `kind: "workflow_run"` PeerRecord. Reuses the
 * existing peer store (one record per run); SQLite lands in a later wave.
 */
export type WorkflowRunConfig = {
  scriptPath: string;
  /** Repository the workflow's agents run against. */
  repo: string;
  /** Wall-clock termination guard enforced by engine.ts. */
  timeoutMs?: number;
  /** Hard cap on total leaves spawned over the run (guard → halted). */
  maxAgents?: number;
  /** Cumulative leaf-token budget (guard → halted). */
  budgetTokens?: number;
  status: WorkflowStatus;
  /** JSON-serializable value the script returned (status "done"). */
  result?: unknown;
  error?: string;
  /** Cumulative leaf tokens spent (budget accounting). */
  tokensSpent?: number;
  /** ctx.agent calls served from the journal on resume (§14). */
  replayedAgents?: number;
  /** Leaf peer ids spawned by ctx.agent, in spawn order. */
  agentPeerIds: string[];
  /** Determinism shims: Math.random seed + fixed Date epoch for the child. */
  seed: number;
  startTimeMs: number;
};

/** A workflow_run record is a PeerRecord whose workflow blob is present. */
export type WorkflowRunRecord = PeerRecord & {
  kind: "workflow_run";
  workflow: WorkflowRunConfig;
};

export function isWorkflowRunRecord(peer: PeerRecord): peer is WorkflowRunRecord {
  return peer.kind === "workflow_run" && peer.workflow !== undefined;
}
