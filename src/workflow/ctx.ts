// src/workflow/ctx.ts
//
// SP1 wave 1 — the parent-side implementation behind the sandboxed script's
// ctx.agent(prompt, opts). One leaf peer per call: spawnPeer (own worktree,
// integrate:false) → waitForPeer → schema validation with a bounded
// resumePeer retry loop (schema.ts). ctx.log is handled by the engine.
//
// All peer machinery is injected (mirrors gsdRunner's deps pattern) so the
// retry/validation loop is unit-testable with fake peers.

import type {
  PeerRecord,
  ResumePeerOptions,
  SpawnPeerOptions,
  WaitPeerOptions,
  WaitPeerResult,
} from "../types.js";
import {
  SCHEMA_MAX_RETRIES,
  extractAgentResult,
  schemaInstruction,
  schemaRetryPrompt,
  validateAgainstSchema,
} from "./schema.js";
import type { WorkflowAgentOpts } from "./types.js";

// The workflow-level timeoutMs guard (engine.ts) is the real brake; this only
// bounds a single leaf wait so a lost peer cannot pin the runner forever.
const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export class WorkflowAgentError extends Error {
  constructor(
    message: string,
    readonly peerId?: string,
  ) {
    super(message);
    this.name = "WorkflowAgentError";
  }
}

export type AgentCallDeps = {
  spawnPeer: (options: SpawnPeerOptions) => PeerRecord;
  waitForPeer: (options: WaitPeerOptions) => Promise<WaitPeerResult>;
  resumePeer: (options: ResumePeerOptions) => PeerRecord;
  /** Read <worktree>/.delamain/result.json; undefined when absent. */
  readAgentResultFile: (peer: PeerRecord) => string | undefined;
  /** Remove a stale result.json before a schema-retry resume. Best-effort. */
  removeAgentResultFile: (peer: PeerRecord) => void;
  /** Engine hook: invoked once per spawned leaf so the run records its ids. */
  onAgentSpawned?: (peer: PeerRecord) => void;
  // SP1 wave 2 — semaphore/guard gating (pool.ts). acquire() runs before
  // spawnPeer (may throw WorkflowAbortedError to abort this leaf) and returns
  // an opaque slot token; release(token) runs in finally and frees exactly
  // that leaf's slot; recordUsage() accounts the terminal leaf's tokens.
  acquire?: () => Promise<SlotToken>;
  release?: (token: SlotToken) => void;
  recordUsage?: (peer: PeerRecord) => void;
  log?: (line: string) => void;
};

/** Opaque per-leaf semaphore slot handle threaded acquire() → release(). */
export type SlotToken = unknown;

export type AgentCallConfig = {
  repo: string;
  waitTimeoutMs?: number;
};

export async function runAgentCall(
  deps: AgentCallDeps,
  config: AgentCallConfig,
  prompt: string,
  opts: WorkflowAgentOpts = {},
): Promise<unknown> {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new WorkflowAgentError("ctx.agent requires a non-empty prompt string");
  }
  const engine = opts.engine ?? "codex";
  if (engine === "pi") {
    throw new WorkflowAgentError("ctx.agent engine 'pi' arrives in SP2 (Pi engine); use 'codex' or 'cursor'");
  }
  if (engine !== "codex" && engine !== "cursor") {
    throw new WorkflowAgentError(`ctx.agent engine ${JSON.stringify(opts.engine)} is not supported (use 'codex' or 'cursor')`);
  }
  if (opts.multiAgent && engine !== "codex") {
    throw new WorkflowAgentError("ctx.agent multiAgent is codex-engine-only");
  }
  const schema = opts.schema;
  const fullPrompt = schema ? `${prompt}\n${schemaInstruction(schema)}` : prompt;
  const waitTimeoutMs = config.waitTimeoutMs ?? DEFAULT_AGENT_WAIT_TIMEOUT_MS;
  const label = opts.phase ? (opts.label ? `${opts.phase}:${opts.label}` : opts.phase) : opts.label;

  // Opt-in codex multi_agent (§9): enable it for THIS leaf via the existing -c
  // passthrough, and keep hooks enabled so SubagentStart/Stop observability
  // returns. delamain's hard wall-clock timeout (waitTimeoutMs = workflow
  // timeoutMs) still bounds the leaf — the token-runaway blast radius is why
  // this is off by default.
  let codexConfig: string[] | undefined;
  let disableHooks: boolean | undefined;
  if (opts.multiAgent) {
    const { maxThreads, csv } = opts.multiAgent;
    if (!Number.isInteger(maxThreads) || maxThreads < 1) {
      throw new WorkflowAgentError("ctx.agent multiAgent.maxThreads must be a positive integer");
    }
    codexConfig = ["features.multi_agent=true", "agents.max_depth=1", `agents.max_threads=${maxThreads}`];
    if (csv) {
      // spawn_agents_on_csv terminates (preferred over open-ended spawning).
      codexConfig.push(`agents.spawn_agents_on_csv=${JSON.stringify(csv)}`);
    }
    disableHooks = false;
  }

  // Two-pool gate: block on a semaphore slot + guard check before spawning.
  // A halted run makes this throw, aborting just this leaf (parallel/pipeline
  // degrade it to null); a hard-cap/budget trip additionally halts the run.
  // The returned token frees THIS leaf's slot in the finally — never a shared
  // field, so concurrent leaves can't release each other's slots.
  const slot = await deps.acquire?.();

  let lastPeer: PeerRecord | undefined;
  try {
    const spawned = deps.spawnPeer({
      repo: config.repo,
      prompt: fullPrompt,
      name: label,
      engine,
      model: opts.model,
      cursorOptions: engine === "cursor" ? opts.cursorOptions : undefined,
      codexConfig,
      disableHooks,
      integrate: false,
    });
    lastPeer = spawned;
    deps.onAgentSpawned?.(spawned);
    deps.log?.(`agent ${spawned.id} spawned${label ? ` (${label})` : ""}`);

    for (let attempt = 0; attempt <= SCHEMA_MAX_RETRIES; attempt += 1) {
      const wait = await deps.waitForPeer({ peerId: spawned.id, timeoutMs: waitTimeoutMs });
      const peer = wait.peer;
      lastPeer = peer;
      if (wait.timedOut) {
        throw new WorkflowAgentError(`agent ${peer.id} still active after ${waitTimeoutMs}ms wait`, peer.id);
      }
      if (peer.status === "waiting") {
        throw new WorkflowAgentError(
          `agent ${peer.id} is waiting for orchestrator input (${peer.question ?? "no question"}); interactive agents are not supported in workflows`,
          peer.id,
        );
      }
      if (peer.status !== "done") {
        throw new WorkflowAgentError(
          `agent ${peer.id} finished with status ${peer.status}${peer.error ? `: ${peer.error}` : ""}`,
          peer.id,
        );
      }

      if (!schema) {
        return peer.finalResult ?? "";
      }

      const extracted = extractAgentResult({
        resultFileContent: deps.readAgentResultFile(peer),
        finalResult: peer.finalResult,
      });
      const errors = extracted.ok ? validateAgainstSchema(extracted.value, schema).errors : [extracted.error];
      if (extracted.ok && errors.length === 0) {
        deps.log?.(`agent ${peer.id} result validated (${extracted.source})`);
        return extracted.value;
      }

      if (attempt >= SCHEMA_MAX_RETRIES) {
        throw new WorkflowAgentError(
          `agent ${peer.id} result failed schema validation after ${SCHEMA_MAX_RETRIES} retries: ${errors.join("; ")}`,
          peer.id,
        );
      }
      deps.log?.(`agent ${peer.id} schema mismatch (attempt ${attempt + 1}): ${errors.join("; ")} — resuming`);
      deps.removeAgentResultFile(peer);
      deps.resumePeer({ peerId: peer.id, prompt: schemaRetryPrompt(errors, schema) });
    }
    // Unreachable: the loop either returns or throws on the last attempt.
    throw new WorkflowAgentError(`agent ${spawned.id} retry loop exited unexpectedly`, spawned.id);
  } finally {
    // A spawned leaf always spent something and always frees its slot, whether
    // it validated, failed, or threw.
    if (lastPeer) deps.recordUsage?.(lastPeer);
    deps.release?.(slot);
  }
}
