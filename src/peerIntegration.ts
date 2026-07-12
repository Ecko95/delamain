// src/peerIntegration.ts
//
// integrate_peer MCP tool implementation: commit + push the peer's own
// branch to origin, then open a pull request against the target branch and
// enable auto-merge (merge when checks pass). This is the EXPLICIT
// invocation path; it never advances main/master directly — a PR does.
// Refuses to act on running or failed peers.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { peersHome } from "./paths.js";
import { getPeer, readState, upsertPeer } from "./store.js";
import { pushPeerBranch } from "./git.js";
import { validateMergeOrder } from "./mergeOrder.js";
import type { PeerRecord } from "./types.js";

export type IntegrationOutcome = {
  ok: boolean;
  target_branch?: string;
  pr_number?: number;
  pr_url?: string;
  auto_merge_enabled?: boolean;
  error?: string;
};

export type OpenPrParams = {
  /** Directory to run `gh` in (the peer worktree); gh infers the repo from origin. */
  repoDir: string;
  base: string;
  head: string;
  title: string;
  body: string;
  autoMerge: boolean;
};

export type OpenPrResult = {
  number?: number;
  url?: string;
  autoMergeEnabled: boolean;
};

/** Injectable so unit tests can drive integration without invoking gh. */
export type PrOpener = (params: OpenPrParams) => Promise<OpenPrResult> | OpenPrResult;

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

export type IntegratePeerOpts = {
  auditLogPath: string;
  /** PR opener; defaults to the real gh-backed implementation. */
  openPr?: PrOpener;
  /** Enable GitHub auto-merge (merge when checks pass). Defaults to true. */
  autoMerge?: boolean;
};

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
  // Citadel-adoption merge-order gate: refuse until every dependsOn peer is
  // merged. Lives here (not in integratePeerWithRecord, which stays pure of
  // the store) so unit tests can still drive the core with fixtures.
  const order = validateMergeOrder(peer, readState().peers);
  if (!order.ok) {
    throw new IntegratePeerRefusedError(
      peer.id,
      peer.status,
      `merge-order: ${order.blockers.map((b) => `${b.dep} is ${b.status}`).join(", ")}. ` +
        `Merge dependencies first (delamain merge-state), or spawn without --depends-on.`,
    );
  }
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

  // 1. Commit the peer's work and push its OWN branch to origin. This never
  // advances the target branch — pushPeerBranch syncs the latest base into the
  // peer branch and pushes the branch only.
  let push;
  try {
    push = pushPeerBranch(worktreePath, peer.id, targetBranch);
  } catch (error) {
    return await failed(peer, opts, `push failed: ${errText(error)}`, ts);
  }

  if (push.status === "skipped") {
    await audit(opts.auditLogPath, {
      event: "integrate_peer",
      peer_id: peer.id,
      kind: peer.kind ?? "generic",
      outcome: "skipped",
      iso8601: ts,
      target_branch: targetBranch,
    });
    return {
      peer: { ...peer, integrationStatus: "skipped" },
      outcome: { ok: true, target_branch: targetBranch },
    };
  }

  // 2. Open a pull request from the peer branch into the target branch and
  // enable auto-merge (merge when checks pass).
  const openPr = opts.openPr ?? ghOpenPullRequest;
  const autoMerge = opts.autoMerge ?? true;
  const title = `peer ${peer.id}: ${peer.task.slice(0, 100)}`;
  const body = [
    `Automated PR opened by delamain for peer \`${peer.id}\` (${peer.kind ?? "generic"}, engine ${peer.engine ?? "codex"}).`,
    "",
    `Branch \`${push.branch}\` → \`${targetBranch}\`.`,
    "",
    "Task:",
    "",
    peer.task,
  ].join("\n");

  let pr: OpenPrResult;
  try {
    pr = await openPr({
      repoDir: worktreePath,
      base: targetBranch,
      head: push.branch,
      title,
      body,
      autoMerge,
    });
  } catch (error) {
    return await failed(peer, opts, `open pull request failed: ${errText(error)}`, ts);
  }

  const outcome: IntegrationOutcome = {
    ok: true,
    target_branch: targetBranch,
    pr_number: pr.number,
    pr_url: pr.url,
    auto_merge_enabled: pr.autoMergeEnabled,
  };
  await audit(opts.auditLogPath, {
    event: "integrate_peer",
    peer_id: peer.id,
    kind: peer.kind ?? "generic",
    outcome: "pushed",
    iso8601: ts,
    target_branch: targetBranch,
    pr_number: pr.number,
    pr_url: pr.url,
    auto_merge_enabled: pr.autoMergeEnabled,
  });
  return {
    peer: {
      ...peer,
      integrationStatus: "pushed",
      integrationPrNumber: pr.number,
      integrationPrUrl: pr.url,
    },
    outcome,
  };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Real PR opener: shells out to `gh` inside the peer worktree (gh infers the
 * repository from origin). Reuses an existing open PR for the same head, then
 * enables auto-merge. A non-fatal auto-merge failure (e.g. the repo has
 * auto-merge disabled) leaves the PR open and reports autoMergeEnabled=false.
 */
async function ghOpenPullRequest(p: OpenPrParams): Promise<OpenPrResult> {
  const gh = (args: string[]) => spawnSync("gh", args, { cwd: p.repoDir, encoding: "utf8" });

  let number: number | undefined;
  let url: string | undefined;

  const existing = gh(["pr", "list", "--head", p.head, "--state", "open", "--json", "number,url", "--limit", "1"]);
  if (existing.status === 0 && existing.stdout.trim()) {
    try {
      const arr = JSON.parse(existing.stdout) as Array<{ number: number; url: string }>;
      if (arr.length > 0) {
        number = arr[0].number;
        url = arr[0].url;
      }
    } catch {
      // fall through to create
    }
  }

  if (number === undefined) {
    const created = gh(["pr", "create", "--base", p.base, "--head", p.head, "--title", p.title, "--body", p.body]);
    if (created.status !== 0) {
      throw new Error(`gh pr create failed: ${created.stderr || created.stdout}`);
    }
    const view = gh(["pr", "view", p.head, "--json", "number,url"]);
    if (view.status === 0) {
      try {
        const j = JSON.parse(view.stdout) as { number: number; url: string };
        number = j.number;
        url = j.url;
      } catch {
        url = created.stdout.trim().split(/\s+/).find((s) => s.startsWith("http"));
      }
    } else {
      url = created.stdout.trim().split(/\s+/).find((s) => s.startsWith("http"));
    }
  }

  let autoMergeEnabled = false;
  if (p.autoMerge && number !== undefined) {
    const merged = gh(["pr", "merge", String(number), "--auto", "--squash"]);
    autoMergeEnabled = merged.status === 0;
  }

  return { number, url, autoMergeEnabled };
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
