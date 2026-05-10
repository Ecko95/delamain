// src/peerIntegration.ts
//
// integrate_peer MCP tool implementation: commit + merge + push from a
// peer's worktree to its target branch. Per Hard Constraint 4 (manual-
// review default), this is the EXPLICIT invocation path; no other code
// path in codex-peers triggers a push. Refuses to act on running or
// failed peers.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { peersHome } from "./paths.js";
import { getPeer, upsertPeer } from "./store.js";
import type { PeerRecord } from "./types.js";

export type IntegrationOutcome = {
  ok: boolean;
  commit_sha?: string;
  merge_commit_sha?: string;
  target_branch?: string;
  error?: string;
};

export class IntegratePeerRefusedError extends Error {
  readonly code = "INTEGRATE_PEER_REFUSED";
  constructor(
    public readonly peerId: string,
    public readonly status: string,
    message: string,
  ) {
    super(
      `integrate_peer: refused for peer ${peerId} in status '${status}': ${message}`,
    );
    this.name = "IntegratePeerRefusedError";
  }
}

const REFUSE_STATUSES = new Set<string>([
  "starting",
  "working",
  "waiting",
  "frozen",
  "gsd_pending",
  "gsd_running_phase",
  "gsd_polling_state",
  "gsd_running_gate_check",
  "gsd_failed",
  "gsd_halted_on_gate_failure",
  "failed",
  "killed",
]);

const ACCEPT_STATUSES = new Set<string>([
  "done",
  "idle",
  "gsd_completed",
]);

export function classifyForIntegration(peer: { status: string }): "accept" | "refuse" {
  if (ACCEPT_STATUSES.has(peer.status)) return "accept";
  if (REFUSE_STATUSES.has(peer.status)) return "refuse";
  // Unknown status: refuse by default (manual-review-safe).
  return "refuse";
}

export type IntegratePeerOpts = { auditLogPath: string };

/**
 * Module-level integratePeer wrapper used by the MCP tool surface.
 * Looks up the peer, computes the audit log path under peersHome(),
 * delegates to integratePeerWithRecord, persists the resulting record.
 */
export async function integratePeer(
  peerId: string,
): Promise<{ peer: PeerRecord; outcome: IntegrationOutcome }> {
  const peer = getPeer(peerId);
  if (!peer) throw new Error(`peer ${peerId} not found`);
  const auditLogPath = join(peersHome(), "integration-audit.log.jsonl");
  const result = await integratePeerWithRecord(peer, { auditLogPath });
  upsertPeer(result.peer);
  return result;
}

/**
 * Core implementation. Takes a PeerRecord directly + an audit log path.
 * Pure of the state store so unit tests can drive it with synthetic
 * fixtures.
 */
export async function integratePeerWithRecord(
  peer: PeerRecord,
  opts: IntegratePeerOpts,
): Promise<{ peer: PeerRecord; outcome: IntegrationOutcome }> {
  if (classifyForIntegration(peer) === "refuse") {
    throw new IntegratePeerRefusedError(
      peer.id,
      peer.status,
      "peer is not in an integratable state",
    );
  }
  const worktreePath = peer.worktreePath ?? peer.repo;
  const targetBranch = peer.mergeBranch ?? peer.baseBranch ?? "main";

  const ts = new Date().toISOString();
  const commitMsg = `peer ${peer.id}: integrate ${peer.kind ?? "generic"} (${peer.task.slice(0, 80)})`;

  // Stage tracked-file modifications only. Per Hard Constraint 8 we avoid
  // the "stage everything" flag; for an integration path the caller has
  // reviewed, we use `git add -u` (only TRACKED file modifications) —
  // safer than -A (which adds untracked files) and matches the
  // "manual-review" posture: the operator has already inspected the diff.
  const stageR = spawnSync("git", ["-C", worktreePath, "add", "-u"], {
    encoding: "utf8",
  });
  if (stageR.status !== 0) {
    return await failed(peer, opts, `git add -u failed: ${stageR.stderr}`, ts);
  }
  // No-op if nothing staged.
  const diffR = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--cached", "--quiet"],
    { encoding: "utf8" },
  );
  let commitSha: string | undefined;
  if (diffR.status === 1) {
    // diff exit 1 = changes staged. Commit.
    const commitR = spawnSync(
      "git",
      ["-C", worktreePath, "commit", "--quiet", "-m", commitMsg],
      { encoding: "utf8" },
    );
    if (commitR.status !== 0) {
      return await failed(peer, opts, `commit failed: ${commitR.stderr}`, ts);
    }
    commitSha = spawnSync(
      "git",
      ["-C", worktreePath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).stdout.trim();
  } else if (diffR.status !== 0) {
    return await failed(
      peer,
      opts,
      `git diff --cached failed: ${diffR.stderr}`,
      ts,
    );
  }

  // Merge into target. The merge happens in the main checkout (the worktree
  // IS the peer branch; merging the peer branch into the target branch from
  // the target-branch checkout is the natural git operation).
  const mainCheckoutR = spawnSync(
    "git",
    ["-C", worktreePath, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (mainCheckoutR.status !== 0) {
    return await failed(
      peer,
      opts,
      `rev-parse --git-common-dir failed: ${mainCheckoutR.stderr}`,
      ts,
    );
  }
  const gitCommonDirRaw = mainCheckoutR.stdout.trim();
  // git-common-dir can be relative to the worktree path; resolve.
  const gitCommonDir = gitCommonDirRaw.startsWith("/")
    ? gitCommonDirRaw
    : join(worktreePath, gitCommonDirRaw);
  const mainRepo = join(gitCommonDir, "..");

  const checkoutR = spawnSync(
    "git",
    ["-C", mainRepo, "checkout", "--quiet", targetBranch],
    { encoding: "utf8" },
  );
  if (checkoutR.status !== 0) {
    return await failed(
      peer,
      opts,
      `checkout ${targetBranch} failed: ${checkoutR.stderr}`,
      ts,
    );
  }
  const peerBranch = peer.worktreeBranch ?? peer.branch;
  if (!peerBranch) {
    return await failed(peer, opts, "peer has no branch to merge", ts);
  }
  const mergeR = spawnSync(
    "git",
    ["-C", mainRepo, "merge", "--no-ff", "--quiet", "-m", commitMsg, peerBranch],
    { encoding: "utf8" },
  );
  if (mergeR.status !== 0) {
    return await failed(peer, opts, `merge failed: ${mergeR.stderr}`, ts);
  }
  const mergeSha = spawnSync(
    "git",
    ["-C", mainRepo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).stdout.trim();

  const pushR = spawnSync(
    "git",
    ["-C", mainRepo, "push", "--quiet", "origin", targetBranch],
    { encoding: "utf8" },
  );
  if (pushR.status !== 0) {
    return await failed(peer, opts, `push failed: ${pushR.stderr}`, ts);
  }

  const outcome: IntegrationOutcome = {
    ok: true,
    commit_sha: commitSha,
    merge_commit_sha: mergeSha,
    target_branch: targetBranch,
  };
  await audit(opts.auditLogPath, {
    event: "integrate_peer",
    peer_id: peer.id,
    kind: peer.kind ?? "generic",
    outcome: "pushed",
    iso8601: ts,
    commit_sha: commitSha,
    merge_commit_sha: mergeSha,
    target_branch: targetBranch,
  });
  return {
    peer: {
      ...peer,
      integrationStatus: "pushed",
      integrationCommitSha: commitSha,
      integrationMergeCommitSha: mergeSha,
    },
    outcome,
  };
}

async function failed(
  peer: PeerRecord,
  opts: IntegratePeerOpts,
  msg: string,
  ts: string,
): Promise<{ peer: PeerRecord; outcome: IntegrationOutcome }> {
  await audit(opts.auditLogPath, {
    event: "integrate_peer",
    peer_id: peer.id,
    kind: peer.kind ?? "generic",
    outcome: "failed",
    iso8601: ts,
    error: msg,
  });
  return {
    peer: { ...peer, integrationStatus: "failed", integrationError: msg },
    outcome: { ok: false, error: msg },
  };
}

async function audit(path: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}
