// src/gsdMilestone.ts
//
// Read-only milestone inspector for the inspect_gsd_milestone MCP tool.
// Clones a repo to a temp dir, reads .planning/, computes per-phase
// readiness flags, returns an ordered phase list. Cleans up the clone.

import { mkdtemp, rm, readdir, stat, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type PhaseReadiness = {
  phase_id: string;
  has_context: boolean;
  has_plan: boolean;
  has_frozen_contract: boolean;
  has_verification: boolean;
  has_summary: boolean;
  plan_paths: string[];
};

export type MilestoneInspection = {
  repo_url: string;
  branch: string;
  milestone?: string;
  phases: PhaseReadiness[];
};

export class InspectMilestoneError extends Error {
  readonly code = "INSPECT_MILESTONE";
  constructor(message: string) {
    super(`inspect_gsd_milestone: ${message}`);
    this.name = "InspectMilestoneError";
  }
}

export async function inspectGsdMilestone(opts: {
  repo_url: string;
  branch?: string;
  milestone_filter?: string;
}): Promise<MilestoneInspection> {
  const tmpDir = await mkdtemp(join(tmpdir(), "inspect-gsd-"));
  try {
    cloneRepo(opts.repo_url, tmpDir);
    const branch = opts.branch ?? detectDefaultBranch(tmpDir);
    if (opts.branch) {
      const r = spawnSync("git", ["-C", tmpDir, "checkout", "--quiet", opts.branch], {
        encoding: "utf8",
      });
      if (r.status !== 0) {
        throw new InspectMilestoneError(`checkout '${opts.branch}' failed: ${r.stderr}`);
      }
    }
    const planningDir = join(tmpDir, ".planning");
    try {
      await access(planningDir);
    } catch {
      throw new InspectMilestoneError(
        `no .planning/ directory in repo at branch '${branch}'`,
      );
    }
    const milestone = await readMilestoneFromRoadmap(planningDir);
    const phases = await listPhases(planningDir, opts.milestone_filter);
    return { repo_url: opts.repo_url, branch, milestone, phases };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function cloneRepo(repoUrl: string, target: string): void {
  const args = [
    "clone",
    "--depth=1",
    "--no-tags",
    "--quiet",
    "--no-local",
    repoUrl,
    target,
  ];
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    // --no-local with file://-style local paths may be rejected when
    // protocol.file.allow is not set. Retry with the protocol allowed.
    const r2 = spawnSync(
      "git",
      ["-c", "protocol.file.allow=always", ...args],
      { encoding: "utf8" },
    );
    if (r2.status !== 0) {
      throw new InspectMilestoneError(`clone failed: ${r.stderr || r2.stderr}`);
    }
  }
}

function detectDefaultBranch(repo: string): string {
  // Try `git symbolic-ref refs/remotes/origin/HEAD` first.
  const r = spawnSync(
    "git",
    ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { encoding: "utf8" },
  );
  if (r.status === 0 && r.stdout) {
    return r.stdout.trim().replace(/^origin\//, "");
  }
  // Fall back to current branch.
  const r2 = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  );
  return (r2.stdout ?? "").trim() || "main";
}

async function readMilestoneFromRoadmap(planningDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(planningDir, "ROADMAP.md"), "utf8");
    // Heuristic: return the first level-1 heading text if present.
    const m = raw.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function listPhases(planningDir: string, filter?: string): Promise<PhaseReadiness[]> {
  const phasesDir = join(planningDir, "phases");
  let entries: string[];
  try {
    entries = await readdir(phasesDir);
  } catch {
    return [];
  }
  const phaseIds: string[] = [];
  for (const entry of entries) {
    const abs = join(phasesDir, entry);
    const st = await stat(abs).catch(() => null);
    if (st?.isDirectory()) phaseIds.push(entry);
  }
  phaseIds.sort((a, b) => comparePhaseIds(a, b));
  const filtered = filter ? phaseIds.filter((id) => id.includes(filter)) : phaseIds;
  const out: PhaseReadiness[] = [];
  for (const phaseId of filtered) {
    out.push(await computeReadiness(phasesDir, phaseId));
  }
  return out;
}

function comparePhaseIds(a: string, b: string): number {
  const na = numericPrefix(a);
  const nb = numericPrefix(b);
  if (na !== undefined && nb !== undefined && na !== nb) return na - nb;
  return a.localeCompare(b);
}

function numericPrefix(id: string): number | undefined {
  const m = id.match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

async function computeReadiness(phasesDir: string, phaseId: string): Promise<PhaseReadiness> {
  const phaseDir = join(phasesDir, phaseId);
  const files = await readdir(phaseDir).catch(() => [] as string[]);
  const numericPrefixStr = phaseId.match(/^(\d+(?:\.\d+)?)/)?.[1] ?? phaseId;
  const planPaths = files
    .filter((f) => /-PLAN\.md$/.test(f))
    .map((f) => join(phaseDir, f));
  let hasContext = files.some((f) => /-CONTEXT\.md$|-DISCUSS\.md$/.test(f));
  if (!hasContext && planPaths.length > 0) {
    // Heuristic: PLAN files containing a <context> block count as having context.
    try {
      const sample = await readFile(planPaths[0], "utf8");
      if (sample.includes("<context>")) hasContext = true;
    } catch {
      /* keep false */
    }
  }
  return {
    phase_id: phaseId,
    has_context: hasContext,
    has_plan: planPaths.length > 0,
    has_frozen_contract: files.includes(`${numericPrefixStr}-FROZEN-CONTRACT.json`),
    has_verification: files.some((f) => /VERIFICATION/.test(f)),
    has_summary: files.some((f) => /-SUMMARY\.md$/.test(f)),
    plan_paths: planPaths,
  };
}
