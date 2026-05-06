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

export function createPeerWorktree(repo: string, peerId: string, baseBranch = "main"): CreatedPeerWorktree {
  const sourceRepo = gitRoot(repo);
  if (!sourceRepo) {
    throw new Error(`Cannot spawn isolated peer: ${repo} is not inside a git repository.`);
  }

  ensureOrigin(sourceRepo);
  fetchOriginBranch(sourceRepo, baseBranch);

  const baseRef = hasRef(sourceRepo, `refs/remotes/origin/${baseBranch}`) ? `origin/${baseBranch}` : baseBranch;
  if (!hasRef(sourceRepo, baseRef)) {
    throw new Error(`Cannot spawn isolated peer: ${baseRef} does not exist.`);
  }

  const branch = `codex-peer/${peerId}`;
  const worktreePath = join(worktreesDir(), repoKey(sourceRepo), peerId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  runGit(sourceRepo, ["worktree", "add", "-b", branch, worktreePath, baseRef]);

  return {
    sourceRepo,
    worktreePath,
    branch,
    baseBranch,
    baseRef,
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

function aheadCount(repo: string, baseRef: string, headRef: string): number {
  const result = runGit(repo, ["rev-list", "--count", `${baseRef}..${headRef}`]);
  return Number(result.stdout.trim()) || 0;
}

function hasRef(repo: string, ref: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }).status === 0;
}

function repoKey(repo: string): string {
  const name = basename(repo).replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
  const hash = createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 12);
  return `${name}-${hash}`;
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
