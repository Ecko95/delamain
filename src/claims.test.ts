import { describe, expect, it } from "vitest";
import { assertValidClaims, claimsOverlap, findClaimConflicts, normalizeClaim } from "./claims.js";
import type { PeerRecord } from "./types.js";

function activePeer(id: string, claims: string[], status = "working"): PeerRecord {
  return { id, repo: "/tmp/x", task: "t", status, startedAt: "", updatedAt: "", logPath: "", claims } as PeerRecord;
}

describe("normalizeClaim", () => {
  it("strips leading ./ and trailing slashes, detects :ro", () => {
    expect(normalizeClaim("./src/api/")).toEqual({ path: "src/api", readOnly: false });
    expect(normalizeClaim("docs:ro")).toEqual({ path: "docs", readOnly: true });
  });
});

describe("claimsOverlap", () => {
  it("parent/child overlap, siblings do not", () => {
    expect(claimsOverlap("src/api", "src/api/users")).toBe(true);
    expect(claimsOverlap("src/api/users", "src/api")).toBe(true);
    expect(claimsOverlap("src/api", "src/apiV2")).toBe(false);
    expect(claimsOverlap("src/api", "src/web")).toBe(false);
  });

  it("exact equality overlaps", () => {
    expect(claimsOverlap("src/api", "src/api")).toBe(true);
  });
});

describe("assertValidClaims", () => {
  it("accepts repo-relative paths and :ro claims", () => {
    expect(() => assertValidClaims(["src/api", "docs:ro"])).not.toThrow();
  });

  it.each([".", "./", "/abs/path", "a/../b", "a\\b", "docs:ro/"])("rejects %j naming the bad claim", (claim) => {
    expect(() => assertValidClaims([claim])).toThrow(`Invalid claim "${claim}"`);
  });
});

describe("findClaimConflicts", () => {
  const peers = [
    activePeer("aaa", ["src/api"]),
    activePeer("bbb", ["src/web:ro"]),
    activePeer("ccc", ["src/db"], "done"), // terminal: never conflicts
  ];

  it("flags write-claim overlap with an active peer", () => {
    const conflicts = findClaimConflicts(["src/api/users"], peers);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ peerId: "aaa", theirs: "src/api", ours: "src/api/users" });
  });

  it("read-only claims never conflict (either side)", () => {
    expect(findClaimConflicts(["src/web"], peers)).toHaveLength(0);
    expect(findClaimConflicts(["src/api:ro"], peers)).toHaveLength(0);
  });

  it("terminal peers' claims are ignored", () => {
    expect(findClaimConflicts(["src/db"], peers)).toHaveLength(0);
  });
});
