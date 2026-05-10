// tests/peerIntegration.test.mjs
//
// Phase 33 plan 04 — integrate_peer unit tests.
// Synthetic local-git repos with a bare upstream + a developer clone +
// a worktree branch standing in for a peer. Drives the pure
// integratePeerWithRecord against the fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { classifyForIntegration, integratePeerWithRecord, IntegratePeerRefusedError } =
  await import(`../dist/peerIntegration.js?cb=${Math.random()}`);

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function makePeerEnv() {
  // Bare upstream repo + a "developer" clone + a worktree branch.
  const bareDir = await mkdtemp(join(tmpdir(), "peer-int-bare-"));
  spawnSync("git", ["-C", bareDir, "init", "--quiet", "--bare", "--initial-branch=main"]);
  const repoDir = await mkdtemp(join(tmpdir(), "peer-int-repo-"));
  spawnSync("git", ["-C", repoDir, "init", "--quiet", "--initial-branch=main"]);
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  git(repoDir, "remote", "add", "origin", bareDir);
  await writeFile(join(repoDir, "README.md"), "init\n", "utf8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "--quiet", "-m", "init");
  git(repoDir, "push", "--quiet", "-u", "origin", "main");
  // Worktree branch for the peer.
  const wtDir = repoDir + "-wt";
  git(repoDir, "worktree", "add", "-b", "peer/abc", wtDir);
  // Modify a tracked file so `git add -u` will stage it.
  await writeFile(join(wtDir, "README.md"), "init\npeer work\n", "utf8");
  return { bareDir, repoDir, wtDir };
}

test("classifyForIntegration accepts gsd_completed / done / idle", () => {
  for (const s of ["gsd_completed", "done", "idle"]) {
    assert.equal(classifyForIntegration({ status: s }), "accept");
  }
});

test("classifyForIntegration refuses running and failed states", () => {
  for (const s of [
    "gsd_pending",
    "gsd_running_phase",
    "gsd_polling_state",
    "gsd_running_gate_check",
    "gsd_failed",
    "gsd_halted_on_gate_failure",
    "failed",
    "killed",
    "working",
  ]) {
    assert.equal(classifyForIntegration({ status: s }), "refuse", `${s} must refuse`);
  }
});

test("classifyForIntegration refuses unknown statuses (safe default)", () => {
  assert.equal(classifyForIntegration({ status: "totally_unknown" }), "refuse");
});

test("integratePeerWithRecord commits + merges + pushes for a gsd_completed peer", async () => {
  const env = await makePeerEnv();
  const auditLog = join(env.repoDir, ".integration-audit.jsonl");
  try {
    const peer = {
      id: "abc",
      repo: env.repoDir,
      task: "demo",
      status: "gsd_completed",
      startedAt: "t",
      updatedAt: "t",
      logPath: "/tmp/abc.log",
      kind: "gsd_phase_batch",
      worktreePath: env.wtDir,
      worktreeBranch: "peer/abc",
      branch: "peer/abc",
      baseBranch: "main",
      mergeBranch: "main",
    };
    const r = await integratePeerWithRecord(peer, { auditLogPath: auditLog });
    assert.equal(r.outcome.ok, true);
    assert.equal(r.peer.integrationStatus, "pushed");
    assert.ok(r.outcome.commit_sha, "commit sha set");
    assert.ok(r.outcome.merge_commit_sha, "merge sha set");
    assert.equal(r.outcome.target_branch, "main");
    // Audit log line.
    const entries = (await readFile(auditLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "pushed");
    assert.equal(entries[0].peer_id, "abc");
    assert.equal(entries[0].event, "integrate_peer");
    assert.equal(entries[0].kind, "gsd_phase_batch");
    // Origin received the push.
    const log = spawnSync("git", ["-C", env.bareDir, "log", "--oneline", "main"], {
      encoding: "utf8",
    }).stdout;
    assert.ok(log.includes("integrate"), `bare repo got the merge: ${log}`);
  } finally {
    await rm(env.bareDir, { recursive: true, force: true });
    await rm(env.repoDir, { recursive: true, force: true });
    await rm(env.wtDir, { recursive: true, force: true });
  }
});

test("integratePeerWithRecord throws IntegratePeerRefusedError for refused statuses", async () => {
  const auditLog = join(tmpdir(), `peer-int-refused-${Date.now()}.jsonl`);
  await assert.rejects(
    () =>
      integratePeerWithRecord(
        {
          id: "x",
          repo: "/tmp",
          task: "t",
          status: "gsd_halted_on_gate_failure",
          startedAt: "t",
          updatedAt: "t",
          logPath: "/tmp/x.log",
        },
        { auditLogPath: auditLog },
      ),
    (err) => err instanceof IntegratePeerRefusedError,
  );
});

test("integratePeerWithRecord records 'failed' outcome on push failure", async () => {
  // Synthetic env without an origin remote → push will fail.
  const dir = await mkdtemp(join(tmpdir(), "peer-int-no-origin-"));
  spawnSync("git", ["-C", dir, "init", "--quiet", "--initial-branch=main"]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "x\n", "utf8");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "init");
  const wt = dir + "-wt";
  git(dir, "worktree", "add", "-b", "peer/y", wt);
  await writeFile(join(wt, "f.txt"), "y\n", "utf8");
  const auditLog = join(dir, "audit.jsonl");
  try {
    const r = await integratePeerWithRecord(
      {
        id: "y",
        repo: dir,
        task: "t",
        status: "done",
        startedAt: "t",
        updatedAt: "t",
        logPath: "/tmp/y.log",
        worktreePath: wt,
        worktreeBranch: "peer/y",
        branch: "peer/y",
        baseBranch: "main",
        mergeBranch: "main",
      },
      { auditLogPath: auditLog },
    );
    assert.equal(r.outcome.ok, false);
    assert.equal(r.peer.integrationStatus, "failed");
    assert.ok(r.peer.integrationError, "error message recorded");
    const entries = (await readFile(auditLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(entries[0].outcome, "failed");
    assert.ok(entries[0].error, "audit entry includes error text");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
