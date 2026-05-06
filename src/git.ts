import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type GitWorktreeInfo = {
  worktreePath?: string;
  gitDir?: string;
  gitCommonDir?: string;
  isLinkedWorktree?: boolean;
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
