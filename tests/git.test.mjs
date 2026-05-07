import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createPeerWorktree, integratePeerWorktree } from "../dist/git.js";
import { projectLabel } from "../dist/dashboard.js";

test("creates peer worktree from origin default branch when default is master", () => {
  const fixture = createFixture("master");
  try {
    process.env.CODEX_PEERS_HOME = join(fixture.root, "home");
    const created = createPeerWorktree(fixture.repo, "master-peer");

    assert.equal(created.baseBranch, "master");
    assert.equal(created.baseRef, "origin/master");
    assert.match(git(["branch", "--show-current"], created.worktreePath).trim(), /^codex-peer\/master-peer$/);
    assert.equal(readFileSync(join(created.worktreePath, "README.md"), "utf8"), "master\n");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("creates peer worktree from origin default branch when default is main", () => {
  const fixture = createFixture("main");
  try {
    process.env.CODEX_PEERS_HOME = join(fixture.root, "home");
    const created = createPeerWorktree(fixture.repo, "main-peer");

    assert.equal(created.baseBranch, "main");
    assert.equal(created.baseRef, "origin/main");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("explicit target branch overrides origin default and integrates back to target branch", () => {
  const fixture = createFixture("main", ["release"]);
  try {
    process.env.CODEX_PEERS_HOME = join(fixture.root, "home");
    const created = createPeerWorktree(fixture.repo, "release-peer", "release");
    writeFileSync(join(created.worktreePath, "peer.txt"), "peer change\n", "utf8");

    const integrated = integratePeerWorktree(created.worktreePath, "release-peer", created.baseBranch);

    assert.equal(created.baseBranch, "release");
    assert.equal(integrated.status, "pushed");
    assert.equal(git(["show", "release:peer.txt"], fixture.origin), "peer change\n");
    assert.throws(() => git(["show", "main:peer.txt"], fixture.origin));
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("start_ref can differ from merge branch", () => {
  const fixture = createFixture("main", ["experiment", "release"]);
  try {
    process.env.CODEX_PEERS_HOME = join(fixture.root, "home");
    const created = createPeerWorktree(fixture.repo, "split-peer", { startRef: "origin/experiment" });
    assert.equal(readFileSync(join(created.worktreePath, "README.md"), "utf8"), "experiment\n");
    writeFileSync(join(created.worktreePath, "peer.txt"), "peer change\n", "utf8");

    const integrated = integratePeerWorktree(created.worktreePath, "split-peer", "release");

    assert.equal(created.baseBranch, "experiment");
    assert.equal(created.baseRef, "origin/experiment");
    assert.equal(integrated.status, "pushed");
    assert.equal(git(["show", "release:peer.txt"], fixture.origin), "peer change\n");
    assert.throws(() => git(["show", "experiment:peer.txt"], fixture.origin));
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("start_ref accepts a local branch and can merge to the origin default branch", () => {
  const fixture = createFixture("main");
  try {
    process.env.CODEX_PEERS_HOME = join(fixture.root, "home");
    git(["checkout", "-b", "local-only"], fixture.repo);
    writeFileSync(join(fixture.repo, "README.md"), "local-only\n", "utf8");
    git(["commit", "-am", "prepare local only"], fixture.repo);
    git(["checkout", "main"], fixture.repo);

    const created = createPeerWorktree(fixture.repo, "local-peer", { startRef: "local-only" });
    writeFileSync(join(created.worktreePath, "peer.txt"), "local peer change\n", "utf8");

    const integrated = integratePeerWorktree(created.worktreePath, "local-peer", "main");

    assert.equal(created.baseBranch, "local-only");
    assert.equal(created.baseRef, "local-only");
    assert.equal(readFileSync(join(created.worktreePath, "README.md"), "utf8"), "local-only\n");
    assert.equal(integrated.status, "pushed");
    assert.equal(git(["show", "main:peer.txt"], fixture.origin), "local peer change\n");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("missing resolvable base branch fails with clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-peers-empty-"));
  try {
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    git(["init", "--bare", origin]);
    git(["init", repo]);
    git(["remote", "add", "origin", origin], repo);
    process.env.CODEX_PEERS_HOME = join(root, "home");

    assert.throws(
      () => createPeerWorktree(repo, "empty-peer"),
      /Cannot resolve peer base branch/,
    );
  } finally {
    cleanupFixture(root);
  }
});

test("project labels prefer source repo path over generated worktree path", () => {
  assert.equal(
    projectLabel({
      sourceRepo: "/Users/example/projects/lovable/isomer",
      repo: "/tmp/codex-peers/worktrees/isomer-123456/abcdef12",
      worktreePath: "/tmp/codex-peers/worktrees/isomer-123456/abcdef12",
    }),
    "lovable/isomer",
  );
});

function createFixture(defaultBranch, extraBranches = []) {
  const root = mkdtempSync(join(tmpdir(), "codex-peers-git-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(["init", "--bare", "--initial-branch", defaultBranch, origin]);
  git(["init", "--initial-branch", defaultBranch, repo]);
  git(["config", "user.name", "Test User"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  writeFileSync(join(repo, "README.md"), `${defaultBranch}\n`, "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "init"], repo);
  git(["remote", "add", "origin", origin], repo);
  git(["push", "-u", "origin", defaultBranch], repo);

  for (const branch of extraBranches) {
    git(["checkout", "-b", branch], repo);
    writeFileSync(join(repo, "README.md"), `${branch}\n`, "utf8");
    git(["commit", "-am", `prepare ${branch}`], repo);
    git(["push", "-u", "origin", branch], repo);
  }
  git(["checkout", defaultBranch], repo);

  return { root, origin, repo };
}

function cleanupFixture(root) {
  rmSync(root, { recursive: true, force: true });
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
