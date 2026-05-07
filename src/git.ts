import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { worktreesDir } from "./paths.js";

export type GitWorktreeInfo = {
  worktreePath?: string;
  gitDir?: string;
  gitCommonDir?: string;
  isLinkedWorktree?: boolean;
};

export type CreatedPeerWorktree = {
  sourceRepo: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  info: GitWorktreeInfo;
};

export type PeerIntegrationResult = {
  status: "skipped" | "pushed";
  message: string;
  committed: boolean;
  pushed: boolean;
};

export type CreatePeerWorktreeOptions = {
  startRef?: string;
  targetBranch?: string;
};

export function gitBranch(repo: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const branch = result.stdout.trim();
  return branch || undefined;
}

export function gitRoot(repo: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const root = result.stdout.trim();
  return result.status === 0 && root ? root : undefined;
}

export function createPeerWorktree(
  repo: string,
  peerId: string,
  options: string | CreatePeerWorktreeOptions = {},
): CreatedPeerWorktree {
  const sourceRepo = gitRoot(repo);
  if (!sourceRepo) {
    throw new Error(`Cannot spawn isolated peer: ${repo} is not inside a git repository.`);
  }

  ensureOrigin(sourceRepo);
  const normalized = normalizeWorktreeOptions(options);
  const startPoint = normalized.startRef
    ? resolveStartRef(sourceRepo, normalized.startRef)
    : resolveOriginStartPoint(sourceRepo, normalized.targetBranch);

  const branch = `codex-peer/${peerId}`;
  const worktreePath = join(worktreesDir(), repoKey(sourceRepo), peerId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  runGit(sourceRepo, ["worktree", "add", "-b", branch, worktreePath, startPoint.baseRef]);

  return {
    sourceRepo,
    worktreePath,
    branch,
    baseBranch: startPoint.baseBranch,
    baseRef: startPoint.baseRef,
    info: gitWorktreeInfo(worktreePath),
  };
}

export function integratePeerWorktree(repo: string, peerId: string, baseBranch = "main"): PeerIntegrationResult {
  const worktreePath = gitRoot(repo);
  if (!worktreePath) {
    throw new Error(`Cannot integrate peer ${peerId}: ${repo} is not inside a git repository.`);
  }

  const committed = commitWorkingTree(worktreePath, peerId);
  ensureOrigin(worktreePath);
  fetchOriginBranch(worktreePath, baseBranch);

  if (aheadCount(worktreePath, `origin/${baseBranch}`, "HEAD") === 0) {
    return {
      status: "skipped",
      message: `No peer changes ahead of origin/${baseBranch}.`,
      committed,
      pushed: false,
    };
  }

  mergeOriginBranch(worktreePath, baseBranch);
  pushHeadToOriginBranch(worktreePath, baseBranch);

  return {
    status: "pushed",
    message: `Merged origin/${baseBranch} and pushed peer ${peerId} to origin/${baseBranch}.`,
    committed,
    pushed: true,
  };
}

export function resolveBaseBranch(repo: string, targetBranch?: string): string {
  if (targetBranch?.trim()) {
    return validateBranchName(targetBranch.trim(), "target branch");
  }

  const remoteDefault = remoteDefaultBranch(repo);
  if (remoteDefault) {
    return remoteDefault;
  }

  const upstream = upstreamBranch(repo);
  if (upstream) {
    return upstream;
  }

  for (const candidate of ["main", "master"]) {
    if (remoteHasBranch(repo, candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Cannot resolve peer base branch: origin HEAD is unavailable and neither origin/main nor origin/master exists. Pass an explicit target branch.",
  );
}

function normalizeWorktreeOptions(options: string | CreatePeerWorktreeOptions): CreatePeerWorktreeOptions {
  if (typeof options === "string") {
    return { targetBranch: options };
  }
  return {
    startRef: options.startRef?.trim() || undefined,
    targetBranch: options.targetBranch?.trim() || undefined,
  };
}

function resolveOriginStartPoint(repo: string, targetBranch?: string): { baseBranch: string; baseRef: string } {
  const baseBranch = resolveBaseBranch(repo, targetBranch);
  fetchOriginBranch(repo, baseBranch);
  const baseRef = hasRef(repo, `refs/remotes/origin/${baseBranch}`) ? `origin/${baseBranch}` : baseBranch;
  if (!hasRef(repo, baseRef)) {
    throw new Error(`Cannot spawn isolated peer: ${baseRef} does not exist.`);
  }
  return { baseBranch, baseRef };
}

function resolveStartRef(repo: string, startRef: string): { baseBranch: string; baseRef: string } {
  const ref = validateStartRef(startRef);
  if (ref.startsWith("origin/")) {
    const branch = validateBranchName(ref.slice("origin/".length), "start origin branch");
    fetchOriginBranch(repo, branch);
    if (!hasRef(repo, `refs/remotes/origin/${branch}`)) {
      throw new Error(`Cannot spawn isolated peer: origin/${branch} does not exist.`);
    }
    return { baseBranch: branch, baseRef: `origin/${branch}` };
  }

  if (hasCommit(repo, ref)) {
    return { baseBranch: ref, baseRef: ref };
  }

  if (remoteHasBranch(repo, ref)) {
    const branch = validateBranchName(ref, "start origin branch");
    fetchOriginBranch(repo, branch);
    return { baseBranch: branch, baseRef: `origin/${branch}` };
  }

  throw new Error(`Cannot spawn isolated peer: start ref '${ref}' does not resolve to a commit or origin branch.`);
}

export function gitWorktreeInfo(repo: string): GitWorktreeInfo {
  const worktreePath = gitRoot(repo);
  if (!worktreePath) {
    return {};
  }

  const gitDir = gitPath(worktreePath, ["rev-parse", "--git-dir"]);
  const gitCommonDir = gitPath(worktreePath, ["rev-parse", "--git-common-dir"]);
  return {
    worktreePath,
    gitDir,
    gitCommonDir,
    isLinkedWorktree: Boolean(gitDir && gitCommonDir && gitDir !== gitCommonDir),
  };
}

function gitPath(repo: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const path = result.stdout.trim();
  return result.status === 0 && path ? resolve(repo, path) : undefined;
}

function commitWorkingTree(repo: string, peerId: string): boolean {
  const status = runGit(repo, ["status", "--porcelain"]).stdout.trim();
  if (!status) {
    return false;
  }

  runGit(repo, ["add", "-A"]);
  const diff = runGit(repo, ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (diff.status === 0) {
    return false;
  }
  runGit(repo, [
    "-c",
    "user.name=Codex Peer",
    "-c",
    "user.email=codex-peer@users.noreply.github.com",
    "commit",
    "-m",
    `Apply Codex peer ${peerId} changes`,
  ]);
  return true;
}

function mergeOriginBranch(repo: string, baseBranch: string): void {
  const ancestor = runGit(repo, ["merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"], {
    allowFailure: true,
  });
  if (ancestor.status === 0) {
    return;
  }
  runGit(repo, ["merge", "--no-edit", `origin/${baseBranch}`]);
}

function pushHeadToOriginBranch(repo: string, baseBranch: string): void {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runGit(repo, ["push", "origin", `HEAD:${baseBranch}`], { allowFailure: true });
    if (result.status === 0) {
      return;
    }

    lastError = gitError(repo, ["push", "origin", `HEAD:${baseBranch}`], result);
    fetchOriginBranch(repo, baseBranch);
    mergeOriginBranch(repo, baseBranch);
  }
  throw lastError || new Error(`git push origin HEAD:${baseBranch} failed`);
}

function ensureOrigin(repo: string): void {
  runGit(repo, ["remote", "get-url", "origin"]);
}

function fetchOriginBranch(repo: string, baseBranch: string): void {
  runGit(repo, ["fetch", "origin", baseBranch]);
}

function remoteDefaultBranch(repo: string): string | undefined {
  const result = runGit(repo, ["ls-remote", "--symref", "origin", "HEAD"], { allowFailure: true });
  if (result.status !== 0) {
    return undefined;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);
    if (match?.[1]) {
      return validateBranchName(match[1], "origin default branch");
    }
  }
  return undefined;
}

function upstreamBranch(repo: string): string | undefined {
  const result = runGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true });
  if (result.status !== 0) {
    return undefined;
  }
  const upstream = result.stdout.trim();
  if (!upstream.startsWith("origin/")) {
    return undefined;
  }
  return validateBranchName(upstream.slice("origin/".length), "upstream branch");
}

function remoteHasBranch(repo: string, branch: string): boolean {
  return runGit(repo, ["ls-remote", "--exit-code", "--heads", "origin", branch], { allowFailure: true }).status === 0;
}

function aheadCount(repo: string, baseRef: string, headRef: string): number {
  const result = runGit(repo, ["rev-list", "--count", `${baseRef}..${headRef}`]);
  return Number(result.stdout.trim()) || 0;
}

function hasRef(repo: string, ref: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }).status === 0;
}

function hasCommit(repo: string, ref: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true }).status === 0;
}

function repoKey(repo: string): string {
  const name = basename(repo).replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
  const hash = createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 12);
  return `${name}-${hash}`;
}

function validateBranchName(branch: string, label: string): string {
  const result = runGit(process.cwd(), ["check-ref-format", "--branch", branch], { allowFailure: true });
  if (result.status !== 0 || branch.startsWith("-")) {
    throw new Error(`Invalid ${label}: ${branch}`);
  }
  return branch;
}

function validateStartRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\u0000-\u001f\s]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid start ref: ${ref}`);
  }
  return trimmed;
}

type GitCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runGit(
  repo: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gitResult = {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
  if (!options.allowFailure && result.status !== 0) {
    throw gitError(repo, args, gitResult);
  }
  return gitResult;
}

function gitError(repo: string, args: string[], result: GitCommandResult): Error {
  const output = `${result.stderr || result.stdout}`.trim();
  return new Error(`git ${args.join(" ")} failed in ${repo}${output ? `: ${output}` : ""}`);
}
