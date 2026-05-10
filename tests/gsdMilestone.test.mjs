// tests/gsdMilestone.test.mjs
//
// Phase 33 plan 04 — inspect_gsd_milestone unit tests. Synthetic local
// git repos with .planning/ skeletons; verify ordered phases, readiness
// flags, decimal sort, milestone filter, missing-.planning error, and
// temp-clone cleanup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { inspectGsdMilestone } = await import(
  `../dist/gsdMilestone.js?cb=${Math.random()}`
);

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function makeMilestoneRepo(phases) {
  // phases: { "<id>": { plan, frozen, verification, summary, context } }
  const dir = await mkdtemp(join(tmpdir(), "inspect-milestone-test-"));
  spawnSync("git", ["-C", dir, "init", "--quiet", "--initial-branch=main"]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await mkdir(join(dir, ".planning", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".planning", "ROADMAP.md"),
    "# Test Milestone v1.0\n\n- 01-foo\n- 02-bar\n",
    "utf8",
  );
  for (const [id, flags] of Object.entries(phases)) {
    const phaseDir = join(dir, ".planning", "phases", id);
    await mkdir(phaseDir, { recursive: true });
    const numericPrefix = id.match(/^(\d+(?:\.\d+)?)/)[1];
    if (flags.plan) {
      await writeFile(
        join(phaseDir, `${numericPrefix}-01-PLAN.md`),
        flags.context ? "<context>\nblah\n</context>\n" : "no context here\n",
        "utf8",
      );
    }
    if (flags.frozen) {
      await writeFile(
        join(phaseDir, `${numericPrefix}-FROZEN-CONTRACT.json`),
        `{"phase_id":"${id}","contracts":[]}`,
        "utf8",
      );
    }
    if (flags.verification) {
      await writeFile(
        join(phaseDir, `${numericPrefix}-VERIFICATION.md`),
        "verification\n",
        "utf8",
      );
    }
    if (flags.summary) {
      await writeFile(
        join(phaseDir, `${numericPrefix}-01-SUMMARY.md`),
        "summary\n",
        "utf8",
      );
    }
    if (flags.context && !flags.plan) {
      await writeFile(
        join(phaseDir, `${numericPrefix}-CONTEXT.md`),
        "context\n",
        "utf8",
      );
    }
  }
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("inspectGsdMilestone returns ordered phases with readiness flags", async () => {
  const repo = await makeMilestoneRepo({
    "01-foo": { plan: true, context: true, frozen: false, verification: true, summary: true },
    "02-bar": { plan: true, context: true, frozen: true, verification: true, summary: true },
  });
  try {
    const r = await inspectGsdMilestone({ repo_url: repo });
    assert.equal(r.phases.length, 2);
    assert.deepEqual(
      r.phases.map((p) => p.phase_id),
      ["01-foo", "02-bar"],
    );
    assert.equal(r.phases[0].has_frozen_contract, false);
    assert.equal(r.phases[1].has_frozen_contract, true);
    assert.equal(r.phases[0].has_plan, true);
    assert.equal(r.phases[0].has_verification, true);
    assert.equal(r.phases[0].has_summary, true);
    assert.equal(r.milestone, "Test Milestone v1.0");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("inspectGsdMilestone sorts decimal phases correctly (33.1 > 33)", async () => {
  const repo = await makeMilestoneRepo({
    "33-base": { plan: true, context: true },
    "33.1-fix": { plan: true, context: true },
    "34-next": { plan: true, context: true },
  });
  try {
    const r = await inspectGsdMilestone({ repo_url: repo });
    assert.deepEqual(
      r.phases.map((p) => p.phase_id),
      ["33-base", "33.1-fix", "34-next"],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("inspectGsdMilestone milestone_filter narrows results", async () => {
  const repo = await makeMilestoneRepo({
    "01-foo": { plan: true, context: true },
    "02-bar": { plan: true, context: true },
    "33-target": { plan: true, context: true },
  });
  try {
    const r = await inspectGsdMilestone({ repo_url: repo, milestone_filter: "33" });
    assert.equal(r.phases.length, 1);
    assert.equal(r.phases[0].phase_id, "33-target");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("inspectGsdMilestone throws InspectMilestoneError when .planning/ missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-planning-"));
  spawnSync("git", ["-C", dir, "init", "--quiet", "--initial-branch=main"]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "no planning here\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  try {
    await assert.rejects(
      () => inspectGsdMilestone({ repo_url: dir }),
      (err) => err.code === "INSPECT_MILESTONE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectGsdMilestone cleans up its temp clone", async () => {
  const repo = await makeMilestoneRepo({ "01-only": { plan: true, context: true } });
  try {
    const before = (await readdir(tmpdir())).filter((d) =>
      d.startsWith("inspect-gsd-"),
    ).length;
    await inspectGsdMilestone({ repo_url: repo });
    const after = (await readdir(tmpdir())).filter((d) =>
      d.startsWith("inspect-gsd-"),
    ).length;
    assert.equal(after, before, "temp clone must be cleaned up");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("inspectGsdMilestone has_context is true when PLAN file contains <context>", async () => {
  const repo = await makeMilestoneRepo({ "01-c": { plan: true, context: true } });
  try {
    const r = await inspectGsdMilestone({ repo_url: repo });
    assert.equal(r.phases[0].has_context, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
