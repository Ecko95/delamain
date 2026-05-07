import test from "node:test";
import assert from "node:assert/strict";
import { commandForKey } from "../dist/dashboard/keybindings.js";
import { createDashboardViewModel, projectLabel, statusColor } from "../dist/dashboard/model.js";
import { bunMissingMessage } from "../dist/dashboard.js";

test("commandForKey maps dashboard shortcuts", () => {
  assert.equal(commandForKey("q"), "quit");
  assert.equal(commandForKey("x"), "enter-kill-mode");
  assert.equal(commandForKey("\r", "kill-confirm"), "confirm-kill");
  assert.equal(commandForKey("\x1b", "kill-confirm"), "cancel-mode");
  assert.equal(commandForKey("\t"), "focus-next");
  assert.equal(commandForKey("\x1b[Z"), "focus-prev");
});

test("createDashboardViewModel counts statuses and cleanup peers", () => {
  const view = createDashboardViewModel([
    peer({ id: "working1", status: "working" }),
    peer({ id: "waiting1", status: "waiting" }),
    peer({ id: "cleanup1", status: "done", integrationStatus: "pushed" }),
    peer({ id: "failed1", status: "failed" }),
  ], {}, { now: new Date("2026-05-07T12:05:00Z") });

  assert.equal(view.counts.working, 1);
  assert.equal(view.counts.waiting, 1);
  assert.equal(view.counts.cleanup, 1);
  assert.equal(view.counts.failed, 1);
});

test("createDashboardViewModel clamps selected index when peers disappear", () => {
  const view = createDashboardViewModel([
    peer({ id: "only", status: "working" }),
  ], { selectedIndex: 99 }, { now: new Date("2026-05-07T12:05:00Z") });

  assert.equal(view.selectedIndex, 0);
  assert.equal(view.selectedPeer?.id, "only");
});

test("createDashboardViewModel includes integration detail and bounded logLines", () => {
  const view = createDashboardViewModel([
    peer({ id: "done1", status: "done", integrationStatus: "pushed" }),
  ], {}, {
    logLimit: 80,
    logProvider: () => Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
  });

  assert.deepEqual(view.details.find((row) => row.label === "integration"), {
    label: "integration",
    value: "pushed",
  });
  assert.equal(view.logLines.length, 80);
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

test("status colors give each dashboard state a distinct visible color", () => {
  const statuses = ["starting", "working", "waiting", "idle", "done", "cleanup", "failed", "frozen", "killed"];
  const colors = statuses.map((status) => statusColor(status));

  assert.equal(new Set(colors).size, statuses.length);
  assert.match(statusColor("waiting"), /^#/);
  assert.match(statusColor("failed"), /^#/);
  assert.match(statusColor("cleanup"), /^#/);
});

test("Bun missing message is actionable for dashboard users", () => {
  const message = bunMissingMessage();
  assert.match(message, /requires Bun/);
  assert.match(message, /codex-peers tmux-status/);
});

function peer(overrides) {
  return {
    id: "peer1",
    repo: "/tmp/repo",
    sourceRepo: "/Users/example/projects/acme/app",
    branch: "main",
    task: "task",
    status: "working",
    startedAt: "2026-05-07T12:00:00Z",
    updatedAt: "2026-05-07T12:00:00Z",
    logPath: "/tmp/peer.log",
    integrationStatus: "pending",
    ...overrides,
  };
}
