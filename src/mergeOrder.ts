import type { PeerRecord } from "./types.js";

export type MergeOrderBlocker = { dep: string; status: string; reason: string };
export type MergeOrderResult = { ok: boolean; blockers: MergeOrderBlocker[] };

/**
 * Pure. A peer may integrate only when every dependsOn peer has
 * integrationStatus "merged" (Citadel core/fleet/session.js:191-228 pattern).
 */
export function validateMergeOrder(peer: PeerRecord, peers: PeerRecord[]): MergeOrderResult {
  const byId = new Map(peers.map((p) => [p.id, p]));
  const blockers: MergeOrderBlocker[] = [];
  for (const dep of peer.dependsOn ?? []) {
    const target = byId.get(dep);
    if (!target) {
      blockers.push({ dep, status: "missing", reason: "dependency peer is not in the registry" });
      continue;
    }
    const status = target.integrationStatus ?? "pending";
    if (status !== "merged") {
      blockers.push({ dep, status, reason: "dependency has not been merged" });
    }
  }
  return { ok: blockers.length === 0, blockers };
}
