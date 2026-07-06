// S3 Tier 1 — task-sizing guardrail (pre-flight check at spawn).
//
// Pure, I/O-free heuristic. The orchestrator *declares* scope; we check the
// declaration — no tokenizer, no repo static analysis (see PLAN-S3-S4 "NOT
// building"). At this tier the verdict is warn-only; the spawnPeer seam logs
// it and never blocks. T1.5 will add a "block" level.

/** Declared blast radius for a peer task. All fields optional — absent = unknown. */
export type TaskScope = {
  files?: number; // orchestrator's estimate of files EDITED
  packages?: number; // count of package/dir clusters touched
  downstream?: string[]; // enumerated cross-package consumer files/fixtures (contract rule)
};

/** Sizing-related spawn args, threaded through spawnPeer without touching types.ts. */
export type SpawnSizingArgs = {
  scope?: TaskScope;
  sizeOverride?: boolean;
};

export type TaskSizeInput = { prompt: string } & SpawnSizingArgs;

export type TaskSizeResult = {
  level: "ok" | "warn";
  reasons: string[];
};

// Thresholds are defaults to calibrate (see PLAN Tier 2), env-tunable via the
// same pattern as CODEX_PEERS_FROZEN_AFTER_MS. ponytail: env override, no config file.
const num = (envKey: string, fallback: number): number => {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ponytail: read at call time (not module load) so tests/operators can tune per-run.
const PROMPT_WARN_CHARS = () => num("DELAMAIN_SIZING_PROMPT_WARN", 12_000); // ~3k tokens
const FILES_WARN = () => num("DELAMAIN_SIZING_FILES_WARN", 8);
const PACKAGES_WARN = () => num("DELAMAIN_SIZING_PACKAGES_WARN", 1); // >1 cluster = cross-package

/**
 * Heuristic size check. Returns warn (never block at Tier 1) when a task looks
 * oversized. `sizeOverride` downgrades any warning to ok while keeping the
 * reasons populated so the caller can still log the override (never silent).
 */
export function checkTaskSize(input: TaskSizeInput): TaskSizeResult {
  const { prompt, scope, sizeOverride } = input;
  const reasons: string[] = [];

  const promptWarn = PROMPT_WARN_CHARS();
  if (prompt.length > promptWarn) {
    reasons.push(`brief ${prompt.length} chars > ${promptWarn} — likely multiple tasks; split it`);
  }

  const filesWarn = FILES_WARN();
  if (scope?.files !== undefined && scope.files > filesWarn) {
    reasons.push(`declared ${scope.files} files > ${filesWarn} — split by directory cluster`);
  }

  // Cross-package / shared-contract rule: multi-package scope MUST enumerate
  // downstream consumers/fixtures (the gpt-5.5 fixture-escape incidents).
  const hasDownstream = (scope?.downstream?.length ?? 0) > 0;
  if ((scope?.packages ?? 0) > PACKAGES_WARN() && !hasDownstream) {
    reasons.push(
      `cross-package scope (${scope?.packages} packages) without enumerated downstream impacts — list consumer files/fixtures or split per package`,
    );
  }

  // ponytail: T1 is warn-only. T1.5 flips oversized → { level: "block" } here and
  // the spawnPeer seam throws (mirroring the git-repo guard). Keep it one branch.
  const level = reasons.length > 0 && !sizeOverride ? "warn" : "ok";
  return { level, reasons };
}
