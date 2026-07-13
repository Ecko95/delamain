import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexContext.js";
import { peersHome } from "./paths.js";
import { priceFor } from "./pricing.js";
import type { PeerRecord } from "./types.js";

export type TokenTotals = { input: number; cached: number; output: number };

/** Last cumulative token_count in a codex rollout JSONL. Pure. */
export function parseSessionTotals(text: string): TokenTotals | undefined {
  let totals: TokenTotals | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.payload?.info?.total_token_usage;
      if (usage && typeof usage.input_tokens === "number") {
        totals = {
          input: usage.input_tokens ?? 0,
          cached: usage.cached_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
        };
      }
    } catch {
      // skip malformed line
    }
  }
  return totals;
}

export function costUsd(totals: TokenTotals, model: string | undefined): number {
  const p = priceFor(model);
  return (
    ((totals.input - totals.cached) / 1e6) * p.inputPerM +
    (totals.cached / 1e6) * p.cachedPerM +
    (totals.output / 1e6) * p.outputPerM
  );
}

function sessionRoots(): string[] {
  // Peers run with CODEX_HOME=~/.delamain/peer-codex-home (runner.ts); the
  // supervisor process does not, so check the peer home first, then fall back.
  return [join(peersHome(), "peer-codex-home", "sessions"), join(codexHome(), "sessions")];
}

/**
 * Find the rollout file for a peer. Mirrors codexContext findSessionFile:
 * peer.threadId is the trailing UUID of `rollout-<ts>-<UUID>.jsonl`, so match
 * by that filename suffix and prefer the most recent mtime (resumes can
 * produce several files for one thread).
 */
export function findRolloutFile(threadId: string): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  for (const root of sessionRoots()) {
    let best: { path: string; mtime: number } | undefined;
    for (const file of walkJsonl(root)) {
      if (!file.endsWith(suffix)) continue;
      const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (mtime === undefined) continue; // vanished between walk and stat
      if (!best || mtime > best.mtime) best = { path: file, mtime };
    }
    if (best) return best.path;
  }
  return undefined;
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // missing, or vanished between walk steps
  }
  for (const name of names) {
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue; // vanished between readdir and stat
    if (stat.isDirectory()) walkJsonl(full, out);
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export type PeerCost = {
  id: string;
  model?: string;
  totals?: TokenTotals;
  usd?: number;
  rolloutFile?: string;
};

export function readPeerCost(peer: PeerRecord): PeerCost {
  if (!peer.threadId) return { id: peer.id, model: peer.model };
  const rolloutFile = findRolloutFile(peer.threadId);
  if (!rolloutFile) return { id: peer.id, model: peer.model };
  const totals = parseSessionTotals(readFileSync(rolloutFile, "utf8"));
  if (!totals) return { id: peer.id, model: peer.model, rolloutFile };
  return { id: peer.id, model: peer.model, totals, usd: costUsd(totals, peer.model), rolloutFile };
}
