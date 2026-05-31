import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createPeerWorktree, gitBranch, gitRoot, gitWorktreeInfo, resolveBaseBranch } from "./git.js";
import { reconcileFinishedWaitingPeer } from "./lifecycle.js";
import { promptsDir, runsDir } from "./paths.js";
import {
  archivePeersByIds,
  getPeer,
  readArchivedPeers,
  readState,
  unarchivePeersByIds,
  updatePeer,
  upsertPeer,
} from "./store.js";
import { killPid, killProcessGroup, pidAlive } from "./processes.js";
import { runGsdPhaseBatch } from "./gsdRunner.js";
import type {
  GsdBatchSpawnConfig,
  PeerRecord,
  PeerStatus,
  ResumePeerOptions,
  SpawnPeerAndWaitOptions,
  SpawnPeerOptions,
  WaitPeerOptions,
  WaitPeerResult,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_LOG_LINES = 80;

export function spawnPeer(options: SpawnPeerOptions): PeerRecord {
  const repo = resolve(options.repo);
  const id = randomUUID().slice(0, 8);
  const sourceRepo = gitRoot(repo);
  if (!sourceRepo) {
    throw new Error(`Cannot spawn isolated peer: ${repo} is not inside a git repository.`);
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
  });

  updatePeer(id, (current) => ({
    ...current,
    runnerPid: runner.pid,
    updatedAt: now(),
    lastEvent: `runner pid=${runner.pid ?? "unknown"}`,
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

export async function spawnPeerAndWait(options: SpawnPeerAndWaitOptions): Promise<WaitPeerResult> {
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
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: `resume runner pid=${runner.pid ?? "unknown"}`,
  }));
  return updated || peer;
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

// Statuses that represent a still-live peer. These are never archived in bulk
// and are refused when archiving by explicit id, so archiving can't hide a
// peer that is still doing work.
const LIVE_STATUSES = new Set<PeerStatus>([
  "starting",
  "working",
  "waiting",
  "idle",
  "gsd_pending",
  "gsd_running_phase",
  "gsd_polling_state",
  "gsd_running_gate_check",
]);

export function isArchivable(peer: PeerRecord): boolean {
  return !LIVE_STATUSES.has(peer.status);
}

export type ArchivePeersResult = {
  archived: string[];
  missing: string[];
  skippedActive: string[];
};

/**
 * Archive peers out of the live list. Pass `allFinished: true` to archive every
 * non-live peer, or `ids` to archive specific peers (id or prefix). Live peers
 * are never archived — they come back in `skippedActive`.
 */
export function archivePeers(options: { ids?: string[]; allFinished?: boolean }): ArchivePeersResult {
  const peers = readState().peers;
  let targetIds: string[];
  let skippedActive: string[] = [];

  if (options.allFinished) {
    targetIds = peers.filter(isArchivable).map((peer) => peer.id);
  } else {
    const queries = options.ids ?? [];
    const resolved = queries
      .map((query) => peers.find((peer) => peer.id === query || peer.id.startsWith(query)))
      .filter((peer): peer is PeerRecord => Boolean(peer));
    skippedActive = resolved.filter((peer) => !isArchivable(peer)).map((peer) => peer.id);
    targetIds = resolved.filter(isArchivable).map((peer) => peer.id);
  }

  const { archived, missing } = archivePeersByIds(targetIds);
  return { archived, missing, skippedActive };
}

export function unarchivePeers(ids: string[]): { restored: string[]; missing: string[] } {
  const archived = readArchivedPeers();
  const resolved = ids
    .map((query) => archived.find((peer) => peer.id === query || peer.id.startsWith(query))?.id)
    .filter((id): id is string => Boolean(id));
  return unarchivePeersByIds(resolved);
}

export function listArchivedPeers(): PeerRecord[] {
  return readArchivedPeers();
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
  return `Codex peers: ${peers.length} | working ${active} | waiting ${waiting} | cleanup ${cleanup} | frozen ${frozen}`;
}

function spawnRunner(args: {
  peerId: string;
  repo: string;
  promptFile: string;
  logPath: string;
  resumeThread?: string;
  mergeBranch?: string;
  model?: string;
  sandbox?: string;
  yolo?: boolean;
  engine?: "codex" | "cursor";
  cursorOptions?: { cloud?: boolean; approveMcps?: boolean; force?: boolean };
}) {
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
