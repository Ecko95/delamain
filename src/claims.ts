import { TERMINAL_PEER_STATUSES } from "./types.js";
import type { PeerRecord } from "./types.js";

export type Claim = { path: string; readOnly: boolean };
export type ClaimConflict = { peerId: string; theirs: string; ours: string };

export function normalizeClaim(raw: string): Claim {
  let path = raw.trim();
  const readOnly = path.endsWith(":ro");
  if (readOnly) path = path.slice(0, -3);
  path = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return { path, readOnly };
}

/**
 * Reject degenerate claims that could never overlap anything (and would persist
 * that way, leaving every future spawn unprotected): empty/".", absolute paths,
 * ".." segments, backslashes, or a stray ":" (e.g. "docs:ro/" — the trailing
 * slash defeats the :ro suffix, so ":" survives into the write-claim path).
 * Applies to ALL claims including :ro; claimsOverride never skips this.
 */
export function assertValidClaims(raw: string[]): void {
  for (const claim of raw) {
    const { path } = normalizeClaim(claim);
    const bad =
      path === "" ||
      path === "." ||
      path.startsWith("/") ||
      path.includes(":") ||
      path.includes("\\") ||
      path.split("/").includes("..");
    if (bad) {
      throw new Error(`Invalid claim "${claim}": expected a repo-relative path prefix, optionally suffixed :ro (e.g. src/api or docs:ro).`);
    }
  }
}

/** Prefix overlap on path-segment boundaries: src/api ~ src/api/users, not src/apiV2. */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}/`);
}

/**
 * Citadel core/coordination/claims.js pattern: write-claims of ACTIVE peers are
 * exclusive by path prefix; read-only claims never conflict.
 */
export function findClaimConflicts(requested: string[], peers: PeerRecord[]): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  const ours = requested.map(normalizeClaim).filter((c) => !c.readOnly);
  for (const peer of peers) {
    if (TERMINAL_PEER_STATUSES.has(peer.status)) continue;
    for (const theirRaw of peer.claims ?? []) {
      const theirs = normalizeClaim(theirRaw);
      if (theirs.readOnly) continue;
      for (const our of ours) {
        if (claimsOverlap(our.path, theirs.path)) {
          conflicts.push({ peerId: peer.id, theirs: theirs.path, ours: our.path });
        }
      }
    }
  }
  return conflicts;
}
