import { execFileSync } from "node:child_process";
import { listPeers } from "./peerManager.js";
import { updatePeer } from "./store.js";
import type { PeerRecord } from "./types.js";

export type PrView = {
  state: "OPEN" | "MERGED" | "CLOSED" | string;
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
    return {
      ...peer,
      integrationError: `PR #${peer.integrationPrNumber} closed without merge`,
      lastEvent: `PR #${peer.integrationPrNumber} closed without merge`,
    };
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
  let pr: PrView;
  try {
    pr = view(peer);
  } catch {
    // gh unavailable / network / PR deleted — leave the record alone.
    return undefined;
  }
  const next = applyPrState(peer, pr);
  if (!next) return undefined;
  return updatePeer(peer.id, () => next);
}

/** Refresh every pushed-with-PR peer. Returns the records that changed. */
export function refreshAllMergeStates(view: GhPrViewFn = ghPrView): PeerRecord[] {
  const changed: PeerRecord[] = [];
  for (const peer of listPeers()) {
    if (peer.integrationStatus !== "pushed" || !peer.integrationPrNumber) continue;
    const next = refreshMergeState(peer, view);
    if (next) changed.push(next);
  }
  return changed;
}
