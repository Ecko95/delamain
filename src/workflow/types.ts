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

/** Cursor-engine-only leaf options (SP1 wave 4). */
export type WorkflowCursorOptions = {
  cloud?: boolean;
  approveMcps?: boolean;
  force?: boolean;
};

/**
 * Opt-in codex multi_agent for a single leaf (§9). Enables codex's stable
 * multi_agent inside that one leaf; off by default (token-runaway blast
 * radius). delamain still owns the hard wall-clock timeout on the leaf.
 */
export type WorkflowMultiAgent = {
  /** agents.max_threads=N */
  maxThreads: number;
  /** When set, prefer spawn_agents_on_csv (it terminates). */
  csv?: string;
};

/** Options accepted by ctx.agent(prompt, opts). */
export type WorkflowAgentOpts = {
  /** "codex" (default) or "cursor". "pi" is reserved for SP2 and rejected. */
  engine?: "codex" | "cursor" | "pi";
  model?: string;
  /** JSON Schema the agent's structured result must validate against. */
  schema?: Record<string, unknown>;
  /** Display name for the spawned leaf peer. */
  label?: string;
  /** Progress-group label (defaults to the current ctx.phase()). */
  phase?: string;
  /** Cursor-engine-only options (ignored for other engines). */
  cursorOptions?: WorkflowCursorOptions;
  /** Pi-engine-only options (ignored for other engines). */
  piOptions?: WorkflowPiOptions;
  /** Codex-engine-only: opt-in bounded multi_agent for this leaf. */
  multiAgent?: WorkflowMultiAgent;
  /** Create the leaf's worktree from this origin ref (defaults to origin default branch). */
  startRef?: string;
  /** Push/merge the leaf's changes to this origin branch on done (defaults to origin default branch). */
  mergeBranch?: string;
  /**
   * true restores the legacy push-on-done leaf (automode goals); default/false
   * keeps the ephemeral, push-free workflow leaf every other ctx.agent spawns.
   */
  integrate?: boolean;
};

/** Pi-engine-only options for ctx.agent (SP2). */
export type WorkflowPiOptions = {
  tools?: string[];
  thinking?: string;
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
  /**
   * Adversarial jury (SP1 wave 5): spawn `jurors` read-only agents (default 3)
   * that each try to REFUTE the claim, defaulting to refuted when uncertain.
   * The claim survives unless a strict majority refutes it. Jurors can be
   * engine-diverse (rotate `engines`) and perspective-diverse (rotate `lens`).
   * Built on parallel()+agent(); a juror that can't vote is dropped.
   */
  verify(claim: string, opts?: WorkflowVerifyOpts): Promise<WorkflowVerifyResult>;
  /** Narrator line appended to the run log. */
  log(message: string): void;
  /** Token budget for the run (SP1 wave 2). */
  budget: WorkflowBudget;
};

export type WorkflowVerifyOpts = {
  /** Number of jurors (default 3). */
  jurors?: number;
  /** Perspectives rotated across jurors (e.g. ["correctness","security","repro"]). */
  lens?: string[];
  /** Engines rotated across jurors for diversity (e.g. ["codex","cursor"]). */
  engines?: Array<"codex" | "cursor">;
  /** Optional model override for every juror. */
  model?: string;
};

export type WorkflowVerdict = { refuted: boolean; reason: string; lens: string | null; engine: string };

export type WorkflowVerifyResult = {
  claim: string;
  /** True unless a strict majority of voting jurors refuted the claim. */
  survived: boolean;
  refutedCount: number;
  /** Number of jurors that actually returned a verdict. */
  jurors: number;
  verdicts: WorkflowVerdict[];
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
  /**
   * Opaque JSON object exposed to the script as the `args` global. Persisted on
   * the run record so --resume replays the identical value (§14 determinism).
   */
  args?: Record<string, unknown>;
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
