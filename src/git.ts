import { spawnSync } from "node:child_process";

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
