import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandForKey } from "../dist/dashboard/keybindings.js";
import { handleDashboardV2Input, initialThemeFromEnv, v2CommandForKey } from "../dist/dashboard/v2Input.js";
import { LogBuffer, formatLogEvent, parseLogChunk } from "../dist/dashboard/logEvents.js";
import { createDashboardViewModel, defaultCollapsedStatuses, fleetGridCells, formatDashboardLogLines, projectLabel, statusActivity, statusColor } from "../dist/dashboard/model.js";
import { cyberpunkTheme, defaultTheme } from "../dist/dashboard/theme.js";
import { bunMissingMessage } from "../dist/dashboard.js";

test("commandForKey maps dashboard shortcuts", () => {
  assert.equal(commandForKey("q"), "quit");
  assert.equal(commandForKey("x"), "enter-kill-mode");
  assert.equal(commandForKey("a"), "enter-answer-mode");
  assert.equal(commandForKey("e"), "jump-error");
  assert.equal(commandForKey("?"), "help");
  assert.equal(commandForKey("\r", "answer"), "submit-answer");
  assert.equal(commandForKey("\r", "kill-confirm"), "confirm-kill");
  assert.equal(commandForKey("\x1b", "kill-confirm"), "cancel-mode");
  assert.equal(commandForKey("\t"), "focus-next");
  assert.equal(commandForKey("\x1b[Z"), "focus-prev");
  assert.equal(commandForKey("\x1b[B", "normal", "peers"), "select-next");
  assert.equal(commandForKey("h", "normal", "peers"), "select-left");
  assert.equal(commandForKey("l", "normal", "peers"), "select-right");
  assert.equal(commandForKey("\x1b[B", "normal", "logs"), "scroll-log-down");
  assert.equal(commandForKey("\x1b[A", "normal", "logs"), "scroll-log-up");
  assert.equal(commandForKey("c"), "toggle-status-group");
  assert.equal(commandForKey("g"), "jump-top");
  assert.equal(commandForKey("G"), "jump-bottom");
  assert.equal(commandForKey("b"), "log-bottom");
  assert.equal(commandForKey("\x1b[F"), "log-bottom");
  assert.equal(commandForKey("t"), "cycle-theme");
});

test("V2 command routing agrees with commandForKey", () => {
  const state = dashboardRuntimeState();
  for (const key of ["q", "a", "e", "?", "h", "l", "\t", "\x1b[B", "\x1b[A", "x"]) {
    assert.equal(v2CommandForKey(key, state), commandForKey(key, "normal", "peers"));
  }
  state.focusPane = "logs";
  assert.equal(v2CommandForKey("\x1b[B", state), commandForKey("\x1b[B", "normal", "logs"));
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
    peer({ id: "done1", status: "done", integrationStatus: "pushed", model: "gpt-5.4" }),
  ], {}, {
    logLimit: 80,
    logProvider: () => Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
  });

  assert.deepEqual(view.details.find((row) => row.label === "integration"), {
    label: "integration",
    value: "pushed",
  });
  assert.deepEqual(view.details.find((row) => row.label === "model"), {
    label: "model",
    value: "gpt-5.4  effort:high",
  });
  assert.equal(view.logLines.length, 80);
});

test("createDashboardViewModel keeps default collapsed status groups in view state", () => {
  const view = createDashboardViewModel([
    peer({ id: "done1", status: "done" }),
    peer({ id: "killed1", status: "killed" }),
  ]);

  assert.deepEqual(view.collapsedStatuses, defaultCollapsedStatuses());
  assert.equal(view.peerOffset, 0);
  assert.equal(view.logOffset, 0);
});

test("createDashboardViewModel includes Codex usage from provider", () => {
  const view = createDashboardViewModel([], {}, {
    codexUsageProvider: () => ({
      limits: [{
        label: "5h",
        usedPercent: 81,
        remainingPercent: 19,
        windowMinutes: 300,
        level: "skull",
      }],
    }),
  });

  assert.equal(view.codexUsage?.limits[0].label, "5h");
  assert.equal(view.codexUsage?.limits[0].level, "skull");
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

test("signal room (cyberpunk) theme is the startup default; DELAMAIN_THEME=default opts out", () => {
  assert.equal(initialThemeFromEnv(undefined), cyberpunkTheme);
  assert.equal(initialThemeFromEnv("cyberpunk"), cyberpunkTheme);
  assert.equal(initialThemeFromEnv("default"), defaultTheme);
});

test("themes define filled-highlight cell colors for selected rows", () => {
  for (const theme of [defaultTheme, cyberpunkTheme]) {
    assert.match(theme.accent, /^#/);
    assert.match(theme.selBg, /^#/);
    assert.match(theme.selFg, /^#/);
  }
  assert.notEqual(cyberpunkTheme.selBg, defaultTheme.selBg);
});

test("cyberpunk theme remaps working status away from the default palette", () => {
  assert.notEqual(statusColor("working", cyberpunkTheme), statusColor("working", defaultTheme));
});

test("default theme preserves the pre-theme dashboard palette exactly", () => {
  assert.equal(defaultTheme.border, "#475569");
  assert.equal(defaultTheme.borderFocused, "#facc15");
  assert.deepEqual(defaultTheme.statusColors, {
    starting: "#60a5fa",
    working: "#22d3ee",
    waiting: "#facc15",
    idle: "#94a3b8",
    done: "#a3a3a3",
    cleanup: "#34d399",
    failed: "#f87171",
    frozen: "#c084fc",
    killed: "#fb923c",
    gsd_pending: "#818cf8",
    gsd_running_phase: "#22d3ee",
    gsd_polling_state: "#60a5fa",
    gsd_running_gate_check: "#fbbf24",
    gsd_halted_on_gate_failure: "#c084fc",
    gsd_completed: "#34d399",
    gsd_failed: "#f87171",
  });
});

test("status activity uses OpenCode-style sweep for active peers and stable labels for terminal states", () => {
  assert.equal(statusActivity("working", 0), "■⬝⬝⬝⬝⬝⬝⬝");
  assert.equal(statusActivity("working", 1), "⬝■⬝⬝⬝⬝⬝⬝");
  assert.equal(statusActivity("working", 8), "⬝⬝⬝⬝⬝⬝■⬝");
  assert.equal(statusActivity("waiting", 0), "WAIT");
  assert.equal(statusActivity("done", 0), "DONE");
});

test("formatDashboardLogLines turns Codex JSON events into readable blocks", () => {
  const lines = formatDashboardLogLines([
    JSON.stringify({ type: "thread.started", thread_id: "abc123" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "codex-peers list",
        aggregated_output: JSON.stringify({ status: "waiting", id: "p1" }),
        exit_code: 0,
        status: "completed",
      },
    }),
    "[delamain] exited code=0 signal=",
  ]);

  assert.match(lines.join("\n"), /thread\.started/);
  assert.match(lines.join("\n"), /command: codex-peers list/);
  assert.match(lines.join("\n"), /\"status\": \"waiting\"/);
  assert.match(lines.join("\n"), /exited code=0/);
});

test("parseLogChunk maps Codex and Cursor events to structured kinds", () => {
  const inputs = [
    [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }), "message"],
    [JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }), "reasoning"],
    [JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd", exit_code: 0 } }), "command"],
    [JSON.stringify({ type: "item.completed", item: { type: "file_change", path: "src/a.ts" } }), "file_change"],
    [JSON.stringify({ type: "error", message: "bad" }), "error"],
    [JSON.stringify({ type: "turn.started", thread_id: "t1" }), "turn"],
    ["[delamain] runner started", "delamain"],
    [JSON.stringify({ type: "stream", event: { type: "assistant", message: "cursor hi" } }), "message"],
  ];

  for (const [line, kind] of inputs) {
    const [event] = parseLogChunk(line, () => new Date("2026-07-06T10:00:00Z"));
    assert.equal(event.kind, kind);
    assert.notEqual(event.kind, "raw");
    assert.equal(event.at, "2026-07-06T10:00:00.000Z");
  }
});

test("parseLogChunk keeps unknown text as raw without raw JSON dumps for known events", () => {
  const [raw] = parseLogChunk("plain old line");
  assert.equal(raw.kind, "raw");
  const [message] = parseLogChunk(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  assert.equal(message.kind, "message");
  assert.doesNotMatch(formatLogEvent(message).join("\n"), /json:/);
});

test("LogBuffer tails only appended bytes and caps the ring buffer", () => {
  const dir = mkdtempSync(join(tmpdir(), "delamain-log-buffer-"));
  const logPath = join(dir, "peer.log");
  writeFileSync(logPath, "one\ntwo\n", "utf8");
  const buffer = new LogBuffer(logPath, 3, () => new Date("2026-07-06T10:00:00Z"));

  assert.deepEqual(buffer.readNew().map((event) => event.title), ["one", "two"]);
  appendFileSync(logPath, "three\nfour\n", "utf8");
  assert.deepEqual(buffer.readNew().map((event) => event.title), ["two", "three", "four"]);
  assert.deepEqual(buffer.readNew().map((event) => event.title), ["two", "three", "four"]);
});

test("fleetGridCells groups peers by project columns and lifecycle stage rows", () => {
  const view = createDashboardViewModel([
    peer({ id: "spawn1", status: "starting", sourceRepo: "/repo/alpha" }),
    peer({ id: "work1", status: "working", sourceRepo: "/repo/alpha" }),
    peer({ id: "wait1", status: "waiting", sourceRepo: "/repo/beta" }),
    peer({ id: "push1", status: "done", integrationStatus: "pushed", sourceRepo: "/repo/beta" }),
  ]);
  const cells = fleetGridCells(view.peers);

  assert.deepEqual(cells.find((cell) => cell.project === "repo/alpha" && cell.stage === "spawn").peers.map((p) => p.id), ["spawn1"]);
  assert.deepEqual(cells.find((cell) => cell.project === "repo/alpha" && cell.stage === "work").peers.map((p) => p.id), ["work1"]);
  assert.deepEqual(cells.find((cell) => cell.project === "repo/beta" && cell.stage === "wait").peers.map((p) => p.id), ["wait1"]);
  assert.deepEqual(cells.find((cell) => cell.project === "repo/beta" && cell.stage === "integrate").peers.map((p) => p.id), ["push1"]);
});

test("answer mode submits selected waiting peer through send_peer_reply path", () => {
  const calls = [];
  const state = dashboardRuntimeState({
    selectedPeerId: "p1",
    visiblePeers: [{ id: "p1", index: 0, status: "waiting", project: "repo/app", lastEvent: "question?", selected: true }],
  });
  const actions = {
    refresh: () => {},
    quit: () => {},
    killPeer: (peerId) => ({ id: peerId }),
    sendPeerReply: (peerId, text) => {
      calls.push({ peerId, text });
      return { id: peerId };
    },
  };

  assert.equal(handleDashboardV2Input("a", state, actions), true);
  assert.equal(state.mode, "answer");
  handleDashboardV2Input("o", state, actions);
  handleDashboardV2Input("k", state, actions);
  handleDashboardV2Input("\r", state, actions);

  assert.deepEqual(calls, [{ peerId: "p1", text: "ok" }]);
  assert.equal(state.mode, "normal");
});

test("Bun missing message is actionable for dashboard users", () => {
  const message = bunMissingMessage();
  assert.match(message, /requires Bun/);
  assert.match(message, /delamain tmux-status/);
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

function dashboardRuntimeState(overrides = {}) {
  return {
    selectedIndex: 0,
    selectedPeerId: undefined,
    focusPane: "peers",
    mode: "normal",
    message: "Ready",
    answerInput: "",
    logOffset: 0,
    peerOffset: 0,
    collapsedStatuses: {},
    collapsedPanes: {},
    followSelectedPeer: true,
    forceLogRefresh: false,
    theme: defaultTheme,
    visiblePeers: [],
    logEventLevels: [],
    ...overrides,
  };
}
