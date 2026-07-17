import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertValidClaims, findClaimConflicts } from "./claims.js";
import { createPeerWorktree, gitBranch, gitRoot, gitWorktreeInfo, resolveBaseBranch } from "./git.js";
import { reconcileFinishedWaitingPeer } from "./lifecycle.js";
import { drainDeliverable, enqueuePeerMessage, formatInboxPrompt } from "./peerInbox.js";
import { promptsDir, runsDir } from "./paths.js";
import { getPeer, readState, updatePeer, upsertPeer } from "./store.js";
import { killPid, killProcessGroup, pidAlive } from "./processes.js";
import { runGsdPhaseBatch } from "./gsdRunner.js";
import { checkTaskSize, type SpawnSizingArgs } from "./taskSizing.js";
import type {
  GsdBatchSpawnConfig,
  PeerRecord,
  ResumePeerOptions,
  SpawnPeerAndWaitOptions,
  SpawnPeerOptions,
  WaitPeerOptions,
  WaitPeerResult,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_LOG_LINES = 80;

// ponytail: scope/sizeOverride are intersected here (not added to SpawnPeerOptions
// in types.ts) to dodge a merge conflict with a parallel branch editing types.ts.
export function spawnPeer(options: SpawnPeerOptions & SpawnSizingArgs): PeerRecord {
  const repo = resolve(options.repo);
  const id = randomUUID().slice(0, 8);
  const sourceRepo = gitRoot(repo);
  if (!sourceRepo) {
    throw new Error(`Cannot spawn isolated peer: ${repo} is not inside a git repository.`);
  }

  // S3 Tier 1 pre-flight sizing check — this is the shared choke point hit by
  // spawn_peer, spawn_peer_and_wait, the CLI, and gsd spawns. Runs before any
  // worktree is provisioned. WARN-ONLY at this tier.
  // ponytail: T1.5 flips warn→throw here, mirroring the git-repo guard above:
  //   if (sizing.level === "block") throw new Error(`Task sizing: ${sizing.reasons.join("; ")} Pass size_override:true to spawn anyway.`);
  const sizing = checkTaskSize({ prompt: options.prompt, scope: options.scope, sizeOverride: options.sizeOverride });
  const sizingNote =
    sizing.level === "warn"
      ? `sizing: WARN — ${sizing.reasons.join("; ")}`
      : options.sizeOverride && sizing.reasons.length > 0
        ? `sizing: override — ${sizing.reasons.join("; ")}`
        : "";
  // Citadel-adoption: validate + persist merge-order dependencies before any
  // worktree is provisioned. getPeer matches by id-prefix, so persist the FULL
  // resolved id — validateMergeOrder later does exact-id lookups.
  const dependsOnInput = options.dependsOn?.filter(Boolean);
  const dependsOn = dependsOnInput?.length
    ? [...new Set(dependsOnInput.map((dep) => {
        const resolved = getPeer(dep);
        if (!resolved) throw new Error(`depends_on/--depends-on: no peer matching ${dep}`);
        return resolved.id;
      }))]
    : undefined;
  // Citadel-adoption: refuse spawns whose write-claims overlap an active peer's,
  // before any worktree is provisioned. Raw strings persist; comparison normalizes.
  const claims = options.claims?.filter(Boolean);
  if (claims?.length) assertValidClaims(claims); // always runs — claimsOverride only skips the CONFLICT check
  if (claims?.length && !options.claimsOverride) {
    // ponytail: TOCTOU ceiling — two concurrent spawns (CLI or MCP) can both
    // pass this read; upgrade to a state lock when the a2a-state-race-lock
    // branch lands.
    const conflicts = findClaimConflicts(claims, readState().peers);
    if (conflicts.length) {
      const detail = conflicts.map((c) => `${c.ours} overlaps ${c.theirs} (peer ${c.peerId})`).join("; ");
      throw new Error(`Claim conflict: ${detail}. Use --claims-override (CLI only) to spawn anyway.`);
    }
  }
  const mergeBranch = resolveBaseBranch(sourceRepo, options.mergeBranch || options.targetBranch);
  const isolated = createPeerWorktree(repo, id, {
    startRef: options.startRef,
    targetBranch: options.targetBranch,
  });
  const root = isolated.worktreePath;
  const worktree = isolated.info;
  const logPath = join(runsDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.log`);
  const promptFile = join(promptsDir(), `${id}.txt`);
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, options.prompt, "utf8");

  const peer: PeerRecord = {
    id,
    name: options.name,
    repo: root,
    sourceRepo: isolated.sourceRepo,
    branch: gitBranch(root),
    baseBranch: isolated.baseBranch,
    baseRef: isolated.baseRef,
    mergeBranch,
    worktreeBranch: isolated.branch,
    worktreePath: worktree.worktreePath,
    gitDir: worktree.gitDir,
    gitCommonDir: worktree.gitCommonDir,
    isLinkedWorktree: worktree.isLinkedWorktree,
    model: options.model,
    task: firstLine(options.prompt),
    status: "starting",
    integrationStatus: "pending",
    engine: options.engine || "codex",
    cursorOptions: options.engine === "cursor" ? options.cursorOptions : undefined,
    piOptions: options.engine === "pi" ? options.piOptions : undefined,
    reasoningEffort: options.reasoningEffort,
    developerInstructions: options.developerInstructions,
    codexConfig: options.codexConfig,
    disableHooks: options.disableHooks,
    dependsOn,
    claims,
    integrate: options.integrate,
    startedAt: now(),
    updatedAt: now(),
    lastHeartbeatAt: now(),
    logPath,
    lastEvent: `queued in ${isolated.branch}; merge target origin/${mergeBranch} (engine=${options.engine || "codex"})`,
  };
  upsertPeer(peer);

  const runner = spawnRunner({
    peerId: id,
    repo: root,
    promptFile,
    logPath,
    mergeBranch: peer.mergeBranch,
    model: options.model,
    sandbox: options.sandbox,
    yolo: options.yolo,
    engine: peer.engine,
    cursorOptions: peer.cursorOptions,
    piOptions: peer.piOptions,
    reasoningEffort: peer.reasoningEffort,
    developerInstructions: peer.developerInstructions,
    codexConfig: peer.codexConfig,
    disableHooks: peer.disableHooks,
    integrate: peer.integrate,
  });

  updatePeer(id, (current) => ({
    ...current,
    runnerPid: runner.pid,
    updatedAt: now(),
    lastEvent: sizingNote ? `runner pid=${runner.pid ?? "unknown"} | ${sizingNote}` : `runner pid=${runner.pid ?? "unknown"}`,
  }));

  return getPeer(id) || peer;
}

/**
 * Phase 33: spawn a GSD-mode peer record without launching any process.
 *
 * Creates a peer with `kind: "gsd_phase_batch"` and `status: "gsd_pending"`.
 * The runner (plans 33-02 / 33-03) will pick up `gsd_pending` records and
 * drive them through the slash-command state machine. This function exists
 * purely so the schema-level entry point is available now and tests can pin
 * the contract.
 *
 * Unlike `spawnPeer`, no worktree is created here — worktree provisioning
 * is the runner's responsibility once it picks the peer off the queue.
 */
export function spawnGsdPhaseBatch(options: {
  repo: string;
  name?: string;
  branch?: string;
  model?: string;
  reasoningEffort?: string;
  gsdBatch: GsdBatchSpawnConfig;
}): PeerRecord {
  const id = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const logPath = join(runsDir(), `${startedAt.replace(/[:.]/g, "-")}-${id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  // Touch the log file so future tailers can open it without race.
  writeFileSync(logPath, "", "utf8");

  const peer: PeerRecord = {
    id,
    name: options.name,
    repo: resolve(options.repo),
    branch: options.branch,
    model: options.model,
    reasoningEffort: options.reasoningEffort as PeerRecord["reasoningEffort"],
    task: `GSD ${options.gsdBatch.planning_mode} batch: ${options.gsdBatch.selected_phases.join(", ")}`,
    status: "gsd_pending",
    startedAt,
    updatedAt: startedAt,
    logPath,
    kind: "gsd_phase_batch",
    gsdBatch: { ...options.gsdBatch },
    lastEvent: `gsd peer queued (${options.gsdBatch.planning_mode} mode, ${options.gsdBatch.selected_phases.length} phases)`,
  };
  upsertPeer(peer);
  return peer;
}

export async function spawnPeerAndWait(options: SpawnPeerAndWaitOptions & SpawnSizingArgs): Promise<WaitPeerResult> {
  const peer = spawnPeer(options);
  return waitForPeer({
    peerId: peer.id,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    logLines: options.logLines,
  });
}

export function resumePeer(options: ResumePeerOptions): PeerRecord {
  const peer = getPeer(options.peerId);
  if (!peer) {
    throw new Error(`Unknown peer: ${options.peerId}`);
  }
  if (!peer.threadId) {
    throw new Error(`Peer ${peer.id} has no known thread id yet.`);
  }
  if (isActive(peer)) {
    throw new Error(`Peer ${peer.id} is still active (${peer.status}). Kill it or wait before resuming.`);
  }

  const promptFile = join(promptsDir(), `${peer.id}-resume-${Date.now()}.txt`);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, options.prompt, "utf8");

  const runner = spawnRunner({
    peerId: peer.id,
    repo: peer.repo,
    promptFile,
    logPath: peer.logPath,
    resumeThread: peer.threadId,
    mergeBranch: peer.mergeBranch || peer.baseBranch,
    model: options.model,
    yolo: options.yolo,
    engine: peer.engine,
    cursorOptions: peer.cursorOptions,
    piOptions: peer.piOptions,
    // Resume keeps the tuning knobs pinned at spawn time; there is no
    // send_peer_reply param to override them mid-flight (not requested).
    reasoningEffort: peer.reasoningEffort,
    developerInstructions: peer.developerInstructions,
    codexConfig: peer.codexConfig,
    disableHooks: peer.disableHooks,
    // An integrate:false leaf must stay push-free across schema-retry resumes.
    integrate: peer.integrate,
  });

  const updated = updatePeer(peer.id, (current) => ({
    ...current,
    status: "starting",
    model: options.model || current.model,
    runnerPid: runner.pid,
    codexPid: undefined,
    question: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    signal: undefined,
    integrationStatus: undefined,
    integrationError: undefined,
    integrationCommitSha: undefined,
    integrationMergeCommitSha: undefined,
    integrationPrNumber: undefined,
    integrationPrUrl: undefined,
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: `resume runner pid=${runner.pid ?? "unknown"}`,
  }));
  return updated || peer;
}

export type DeliverPendingResult = { delivered: number; skipped?: string };

// Turn-boundary delivery: if the receiver is at a boundary and has undelivered
// mail, drain it and resume the peer exactly once with the formatted prompt.
// Re-reads current status from the store immediately before acting so an
// operator send_peer_reply racing an auto-delivery can't both resume. `resume`
// is injectable so tests can run without spawning a real process.
export function deliverPending(
  peerId: string,
  resume: (options: ResumePeerOptions) => PeerRecord = resumePeer,
): DeliverPendingResult {
  const peer = getPeer(peerId);
  if (!peer) {
    return { delivered: 0, skipped: "unknown-peer" };
  }
  if (peer.status !== "waiting" && peer.status !== "idle" && peer.status !== "done") {
    return { delivered: 0, skipped: `status=${peer.status}` };
  }
  if (!peer.threadId) {
    // resumePeer needs a thread id; without one the messages stay queued for a
    // later boundary rather than being drained and lost.
    return { delivered: 0, skipped: "no-thread" };
  }
  const messages = drainDeliverable(peerId);
  if (messages.length === 0) {
    return { delivered: 0, skipped: "empty" };
  }
  resume({ peerId, prompt: formatInboxPrompt(messages) });
  return { delivered: messages.length };
}

export type SendPeerMessageInput = {
  fromPeerId: string;
  toPeerId: string;
  message: string;
  expectReply?: boolean;
  responseId?: string;
};

// Single send surface shared by the MCP tool and the CLI: enqueue, then attempt
// immediate turn-boundary delivery. Keeping both callers on this helper is what
// guarantees the two surfaces can't diverge on delivery semantics (the CLI
// shipped enqueue-only once; the live round-trip test caught it).
export function sendPeerMessage(
  input: SendPeerMessageInput,
  resume: (options: ResumePeerOptions) => PeerRecord = resumePeer,
): { responseId?: string; delivery: DeliverPendingResult } {
  const { responseId } = enqueuePeerMessage(input);
  const delivery = deliverPending(input.toPeerId, resume);
  return { responseId, delivery };
}

export function listPeers(): PeerRecord[] {
  return readState().peers.map(reconciledPeer);
}

export function peerStatus(peerId: string): PeerRecord {
  const peer = getPeer(peerId);
  if (!peer) {
    throw new Error(`Unknown peer: ${peerId}`);
  }
  return reconciledPeer(peer);
}

export async function waitForPeer(options: WaitPeerOptions): Promise<WaitPeerResult> {
  const startedAt = Date.now();
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_WAIT_POLL_INTERVAL_MS);
  const logLines = clampLogLines(options.logLines);
  let peer = peerStatus(options.peerId);

  while (isActive(peer)) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      return {
        peer,
        timedOut: true,
        elapsedMs,
        logTail: logLines > 0 ? safeReadPeerLog(peer.id, logLines) : undefined,
      };
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
    peer = peerStatus(options.peerId);
  }

  return {
    peer,
    timedOut: false,
    elapsedMs: Date.now() - startedAt,
    logTail: logLines > 0 ? safeReadPeerLog(peer.id, logLines) : undefined,
  };
}

export function readPeerLog(peerId: string, lines = 120): string {
  const peer = peerStatus(peerId);
  const raw = readFileSync(peer.logPath, "utf8");
  return raw.split(/\r?\n/).slice(-lines).join("\n");
}

export function killPeer(peerId: string, signal: NodeJS.Signals = "SIGTERM"): PeerRecord {
  const peer = peerStatus(peerId);
  killProcessGroup(peer.codexPid, signal);
  killProcessGroup(peer.enginePid, signal);
  killPid(peer.runnerPid, signal);
  const updated = updatePeer(peer.id, (current) => ({
    ...current,
    status: "killed",
    signal,
    finishedAt: now(),
    updatedAt: now(),
    lastEvent: `killed with ${signal}`,
  }));
  return updated || peer;
}

// ---------------------------------------------------------------------------
// Phase 33 plan 02 — GSD peer dispatch wiring.
//
// `dispatchGsdPeer` picks up a `gsd_pending` peer with kind=gsd_phase_batch
// and drives it through the dynamic-mode state machine in gsdRunner.ts.
// The dispatch is fire-and-forget for the caller (MCP tool handler can
// optionally `await _awaitGsdRunner` for tests / integration verification).
//
// Note: `spawnGsdPhaseBatch` deliberately does NOT auto-dispatch in this
// plan to preserve backwards compatibility with the 33-01 test contract
// (which asserts that the record returns synchronously as `gsd_pending`).
// The MCP tool handler in plan 33-04 will call `dispatchGsdPeer` explicitly
// after `spawnGsdPhaseBatch`. Generic-peer flow (`spawnPeer`) is unchanged.
// ---------------------------------------------------------------------------

const gsdRunners = new Map<string, Promise<PeerRecord>>();

export function dispatchGsdPeer(
  peerId: string,
  opts?: { codexBin?: string },
): Promise<PeerRecord> {
  const peer = getPeer(peerId);
  if (!peer) {
    throw new Error(`dispatchGsdPeer: unknown peer ${peerId}`);
  }
  if (peer.kind !== "gsd_phase_batch") {
    throw new Error(
      `dispatchGsdPeer: peer ${peerId} kind=${peer.kind ?? "generic"}; only gsd_phase_batch peers are dispatched here`,
    );
  }
  if (gsdRunners.has(peerId)) {
    return gsdRunners.get(peerId) as Promise<PeerRecord>;
  }
  const promise = runGsdPhaseBatch(
    peer,
    {
      updatePeer: async (id, patch) => applyGsdPatch(id, patch),
      appendLog: async (p, line) => {
        try {
          await appendFile(p.logPath, line, "utf8");
        } catch {
          /* log append best-effort */
        }
      },
    },
    opts,
  ).catch(async (err: Error) => {
    return applyGsdPatch(peerId, {
      status: "gsd_failed",
      lastEvent: `gsdRunner threw: ${err.message}`,
      error: err.message,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  });
  gsdRunners.set(peerId, promise);
  return promise;
}

function applyGsdPatch(id: string, patch: Partial<PeerRecord>): PeerRecord {
  const merged = updatePeer(id, (current) => ({ ...current, ...patch }));
  if (!merged) {
    throw new Error(`applyGsdPatch: peer ${id} not found`);
  }
  return merged;
}

/** Test-only hook to await a dispatched runner. Not exposed via MCP. */
export function _awaitGsdRunner(peerId: string): Promise<PeerRecord> | undefined {
  return gsdRunners.get(peerId);
}

export function tmuxStatusLine(): string {
  const peers = listPeers();
  const counts = new Map<string, number>();
  for (const peer of peers) {
    const status = peer.status === "done" && peer.integrationStatus === "pushed" ? "cleanup" : peer.status;
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const active = (counts.get("starting") || 0) + (counts.get("working") || 0);
  const waiting = counts.get("waiting") || 0;
  const cleanup = counts.get("cleanup") || 0;
  const frozen = counts.get("frozen") || 0;
  // SP1 wave 4: surface running workflows in the status line.
  const workflowsRunning = peers.filter((p) => p.kind === "workflow_run" && p.workflow?.status === "running").length;
  const workflowSuffix = workflowsRunning > 0 ? ` | ❊ ${workflowsRunning} workflow${workflowsRunning === 1 ? "" : "s"}` : "";
  return `Codex peers: ${peers.length} | working ${active} | waiting ${waiting} | cleanup ${cleanup} | frozen ${frozen}${workflowSuffix}`;
}

export type RunnerSpawnArgs = {
  peerId: string;
  repo: string;
  promptFile: string;
  logPath: string;
  resumeThread?: string;
  mergeBranch?: string;
  model?: string;
  sandbox?: string;
  yolo?: boolean;
  engine?: "codex" | "cursor" | "pi";
  cursorOptions?: { cloud?: boolean; approveMcps?: boolean; force?: boolean };
  piOptions?: { tools?: string[]; thinking?: string };
  reasoningEffort?: string;
  developerInstructions?: string;
  codexConfig?: string[];
  disableHooks?: boolean;
  integrate?: boolean;
};

/**
 * Pure argv builder for the `run-peer` child process, split out from
 * spawnRunner so the CLI serialization round trip (option → argv →
 * runner.ts parseArgs) is unit-testable without actually spawning a process.
 */
export function buildRunnerArgv(args: RunnerSpawnArgs): string[] {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  const runnerArgs = [
    entry,
    "run-peer",
    "--peer-id",
    args.peerId,
    "--repo",
    args.repo,
    "--prompt-file",
    args.promptFile,
    "--log-path",
    args.logPath,
  ];
  if (args.resumeThread) {
    runnerArgs.push("--resume-thread", args.resumeThread);
  }
  if (args.mergeBranch) {
    runnerArgs.push("--merge-branch", args.mergeBranch);
  }
  if (args.model) {
    runnerArgs.push("--model", args.model);
  }
  if (args.sandbox) {
    runnerArgs.push("--sandbox", args.sandbox);
  }
  if (args.yolo) {
    runnerArgs.push("--yolo");
  }
  if (args.engine) {
    runnerArgs.push("--engine", args.engine);
  }
  if (args.engine === "cursor") {
    if (args.cursorOptions?.cloud) runnerArgs.push("--cursor-cloud");
    if (args.cursorOptions?.approveMcps) runnerArgs.push("--cursor-approve-mcps");
    if (args.cursorOptions?.force === false) runnerArgs.push("--no-cursor-force");
  }
  if (args.engine === "pi") {
    if (args.piOptions?.tools?.length) runnerArgs.push("--pi-tools", args.piOptions.tools.join(","));
    if (args.piOptions?.thinking) runnerArgs.push("--pi-thinking", args.piOptions.thinking);
  }
  if (args.reasoningEffort) {
    runnerArgs.push("--reasoning-effort", args.reasoningEffort);
  }
  if (args.developerInstructions) {
    runnerArgs.push("--developer-instructions", args.developerInstructions);
  }
  if (args.codexConfig) {
    for (const pair of args.codexConfig) {
      runnerArgs.push("--codex-config", pair);
    }
  }
  if (args.integrate === false) {
    runnerArgs.push("--no-integrate");
  }
  if (args.disableHooks === false) {
    runnerArgs.push("--keep-hooks");
  }
  return runnerArgs;
}

function spawnRunner(args: RunnerSpawnArgs) {
  const runnerArgs = buildRunnerArgv(args);

  const child = spawn(process.execPath, runnerArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

function reconciledPeer(peer: PeerRecord): PeerRecord {
  // Phase 33: GSD-kind peers have their own state machine (driven by the
  // runner in plans 33-02/03). They don't carry runnerPid/codexPid during
  // the schema-only 33-01 step, so skip generic-peer reconciliation entirely.
  if (peer.kind === "gsd_phase_batch") {
    return peer;
  }
  // SP1 wave 1: workflow_run records carry no single engine pid; the workflow
  // engine emits its own heartbeat and enforces its own timeoutMs, so the
  // generic frozen detection would only false-positive here (same as GSD).
  if (peer.kind === "workflow_run") {
    return peer;
  }
  const enriched = reconcileFinishedWaitingPeer(withWorktreeInfo(peer));
  if (!isActive(enriched)) {
    return enriched;
  }
  const runnerAlive = pidAlive(enriched.runnerPid);
  const codexAlive = pidAlive(enriched.codexPid);
  if (!runnerAlive && !codexAlive) {
    return { ...enriched, status: "frozen", lastEvent: "runner/codex pid no longer alive" };
  }
  const heartbeatAge = enriched.lastHeartbeatAt ? Date.now() - Date.parse(enriched.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const frozenAfter = Number(process.env.CODEX_PEERS_FROZEN_AFTER_MS || 120_000);
  if (heartbeatAge > frozenAfter) {
    return { ...enriched, status: "frozen", lastEvent: `heartbeat stale ${Math.round(heartbeatAge / 1000)}s` };
  }
  return enriched;
}

function isActive(peer: PeerRecord): boolean {
  return peer.status === "starting" || peer.status === "working";
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampLogLines(value: number | undefined): number {
  const lines = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_WAIT_LOG_LINES;
  return Math.min(Math.max(lines, 0), 500);
}

function safeReadPeerLog(peerId: string, lines: number): string | undefined {
  try {
    return readPeerLog(peerId, lines);
  } catch {
    return undefined;
  }
}

function withWorktreeInfo(peer: PeerRecord): PeerRecord {
  if (peer.worktreePath && peer.gitDir && peer.gitCommonDir && typeof peer.isLinkedWorktree === "boolean") {
    return peer;
  }

  const worktree = gitWorktreeInfo(peer.repo);
  return {
    ...peer,
    branch: peer.branch || gitBranch(peer.repo),
    worktreePath: peer.worktreePath || worktree.worktreePath,
    gitDir: peer.gitDir || worktree.gitDir,
    gitCommonDir: peer.gitCommonDir || worktree.gitCommonDir,
    isLinkedWorktree: peer.isLinkedWorktree ?? worktree.isLinkedWorktree,
  };
}

function firstLine(prompt: string): string {
  return prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) || "Codex peer task";
}

function now(): string {
  return new Date().toISOString();
}
