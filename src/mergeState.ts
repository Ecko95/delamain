import { execFileSync } from "node:child_process";
import { listPeers } from "./peerManager.js";
import { updatePeer } from "./store.js";
import type { PeerRecord } from "./types.js";

export type PrView = {
  state: "OPEN" | "MERGED" | "CLOSED" | (string & {});
  mergeCommit?: { oid?: string } | null;
};

/**
 * Pure: given a peer and its PR's current view, return the updated record, or
 * undefined when nothing should change. Citadel-style "merged is a first-class
 * status" — see .codex/plans/20260712-citadel-adoptions.md.
 */
export function applyPrState(peer: PeerRecord, pr: PrView): PeerRecord | undefined {
  if (peer.integrationStatus !== "pushed" || !peer.integrationPrNumber) return undefined;
  if (pr.state === "MERGED") {
    return {
      ...peer,
      integrationStatus: "merged",
      integrationMergeCommitSha: pr.mergeCommit?.oid,
      lastEvent: `PR #${peer.integrationPrNumber} merged`,
    };
  }
  if (pr.state === "CLOSED") {
    const message = `PR #${peer.integrationPrNumber} closed without merge`;
    // Idempotent: already recorded — don't rewrite state / re-report as changed.
    if (peer.integrationError === message) return undefined;
    return { ...peer, integrationError: message, lastEvent: message };
  }
  return undefined;
}

export type GhPrViewFn = (peer: PeerRecord) => PrView;

export function ghPrView(peer: PeerRecord): PrView {
  const out = execFileSync(
    "gh",
    ["pr", "view", String(peer.integrationPrNumber), "--json", "state,mergeCommit"],
    { cwd: peer.sourceRepo ?? peer.repo, encoding: "utf8" },
  );
  return JSON.parse(out) as PrView;
}

/** Refresh one peer; returns the updated record or undefined when unchanged. */
export function refreshMergeState(peer: PeerRecord, view: GhPrViewFn = ghPrView): PeerRecord | undefined {
  if (peer.integrationStatus !== "pushed" || !peer.integrationPrNumber) return undefined;
  let pr: PrView;
  try {
    pr = view(peer);
  } catch (error) {
    // gh unavailable / network / PR deleted — leave the record alone.
    console.error(`merge-state: peer ${peer.id}: gh pr view failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!applyPrState(peer, pr)) return undefined;
  // Re-apply against the fresh record inside updatePeer's locked read-modify-write
  // so a snapshot taken before the gh call can't clobber concurrent updates.
  let changed: PeerRecord | undefined;
  updatePeer(peer.id, (fresh) => {
    changed = applyPrState(fresh, pr);
    return changed ?? fresh;
  });
  return changed;
}

/** Refresh every pushed-with-PR peer. Returns the records that changed. */
export function refreshAllMergeStates(view: GhPrViewFn = ghPrView): PeerRecord[] {
  const changed: PeerRecord[] = [];
  for (const peer of listPeers()) {
    const next = refreshMergeState(peer, view);
    if (next) changed.push(next);
  }
  return changed;
}
