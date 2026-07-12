import { claimsOverlap, normalizeClaim } from "./claims.js";
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
    } else if (peer.integrationStatus === "pushed") {
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
    for (let j = i + 1; j < active.length; j++) {
      for (const oursRaw of active[i].claims ?? []) {
        const ours = normalizeClaim(oursRaw);
        if (ours.readOnly) continue;
        for (const theirsRaw of active[j].claims ?? []) {
          const theirs = normalizeClaim(theirsRaw);
          if (theirs.readOnly) continue;
          if (claimsOverlap(ours.path, theirs.path)) {
            view.claimConflicts.push({ a: active[i].id, b: active[j].id, ours: ours.path, theirs: theirs.path });
          }
        }
      }
    }
  }
  return view;
}
