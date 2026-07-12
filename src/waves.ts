import { findClaimConflicts } from "./claims.js";
import { validateMergeOrder, type MergeOrderBlocker } from "./mergeOrder.js";
import { TERMINAL_PEER_STATUSES } from "./types.js";
import type { PeerRecord } from "./types.js";

export type WavesView = {
  running: PeerRecord[];
  awaitingIntegration: PeerRecord[];
  mergeReady: PeerRecord[];
  mergeBlocked: { peer: PeerRecord; blockers: MergeOrderBlocker[] }[];
  merged: PeerRecord[];
  claimConflicts: { a: string; b: string; ours: string; theirs: string }[];
};

/** Pure fleet-state view (Citadel core/fleet/session.js readiness pattern). */
export function wavesView(peers: PeerRecord[]): WavesView {
  const view: WavesView = {
    running: [],
    awaitingIntegration: [],
    mergeReady: [],
    mergeBlocked: [],
    merged: [],
    claimConflicts: [],
  };

  for (const peer of peers) {
    if (peer.integrationStatus === "merged") {
      view.merged.push(peer);
    } else if (peer.integrationStatus === "pushed" && TERMINAL_PEER_STATUSES.has(peer.status)) {
      // A resumed peer keeps integrationStatus "pushed" while producing new
      // commits — only terminal-status peers count as merge-ready/blocked.
      const order = validateMergeOrder(peer, peers);
      if (order.ok) view.mergeReady.push(peer);
      else view.mergeBlocked.push({ peer, blockers: order.blockers });
    } else if (TERMINAL_PEER_STATUSES.has(peer.status)) {
      view.awaitingIntegration.push(peer);
    } else {
      view.running.push(peer);
    }
  }

  const active = peers.filter((p) => !TERMINAL_PEER_STATUSES.has(p.status));
  for (let i = 0; i < active.length; i++) {
    for (const c of findClaimConflicts(active[i].claims ?? [], active.slice(i + 1))) {
      view.claimConflicts.push({ a: active[i].id, b: c.peerId, ours: c.ours, theirs: c.theirs });
    }
  }
  return view;
}
