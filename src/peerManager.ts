import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { gitBranch, gitRoot } from "./git.js";
import { promptsDir, runsDir } from "./paths.js";
import { getPeer, readState, updatePeer, upsertPeer } from "./store.js";
import { killPid, killProcessGroup, pidAlive } from "./processes.js";
import type {
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

export function spawnPeer(options: SpawnPeerOptions): PeerRecord {
  const repo = resolve(options.repo);
  const root = gitRoot(repo) || repo;
  const id = randomUUID().slice(0, 8);
  const logPath = join(runsDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.log`);
  const promptFile = join(promptsDir(), `${id}.txt`);
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, options.prompt, "utf8");

  const peer: PeerRecord = {
    id,
    name: options.name,
    repo: root,
    branch: gitBranch(root),
    task: firstLine(options.prompt),
    status: "starting",
    startedAt: now(),
    updatedAt: now(),
    lastHeartbeatAt: now(),
    logPath,
    lastEvent: "queued",
  };
  upsertPeer(peer);

  const runner = spawnRunner({
    peerId: id,
    repo: root,
    promptFile,
    logPath,
    model: options.model,
    sandbox: options.sandbox,
    yolo: options.yolo,
  });

  updatePeer(id, (current) => ({
    ...current,
    runnerPid: runner.pid,
    updatedAt: now(),
    lastEvent: `runner pid=${runner.pid ?? "unknown"}`,
  }));

  return getPeer(id) || peer;
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
    throw new Error(`Peer ${peer.id} has no known Codex thread id yet.`);
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
    model: options.model,
    yolo: options.yolo,
  });

  const updated = updatePeer(peer.id, (current) => ({
    ...current,
    status: "starting",
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

export function tmuxStatusLine(): string {
  const peers = listPeers();
  const counts = new Map<string, number>();
  for (const peer of peers) {
    counts.set(peer.status, (counts.get(peer.status) || 0) + 1);
  }
  const active = (counts.get("starting") || 0) + (counts.get("working") || 0);
  const waiting = counts.get("waiting") || 0;
  const frozen = counts.get("frozen") || 0;
  return `Codex peers: ${peers.length} | working ${active} | waiting ${waiting} | frozen ${frozen}`;
}

function spawnRunner(args: {
  peerId: string;
  repo: string;
  promptFile: string;
  logPath: string;
  resumeThread?: string;
  model?: string;
  sandbox?: string;
  yolo?: boolean;
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
  if (args.model) {
    runnerArgs.push("--model", args.model);
  }
  if (args.sandbox) {
    runnerArgs.push("--sandbox", args.sandbox);
  }
  if (args.yolo) {
    runnerArgs.push("--yolo");
  }

  const child = spawn(process.execPath, runnerArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

function reconciledPeer(peer: PeerRecord): PeerRecord {
  if (!isActive(peer)) {
    return peer;
  }
  const runnerAlive = pidAlive(peer.runnerPid);
  const codexAlive = pidAlive(peer.codexPid);
  if (!runnerAlive && !codexAlive) {
    return { ...peer, status: "frozen", lastEvent: "runner/codex pid no longer alive" };
  }
  const heartbeatAge = peer.lastHeartbeatAt ? Date.now() - Date.parse(peer.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const frozenAfter = Number(process.env.CODEX_PEERS_FROZEN_AFTER_MS || 120_000);
  if (heartbeatAge > frozenAfter) {
    return { ...peer, status: "frozen", lastEvent: `heartbeat stale ${Math.round(heartbeatAge / 1000)}s` };
  }
  return peer;
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

function firstLine(prompt: string): string {
  return prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) || "Codex peer task";
}

function now(): string {
  return new Date().toISOString();
}
