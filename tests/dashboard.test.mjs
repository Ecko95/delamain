import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandForKey } from "../dist/dashboard/keybindings.js";
import { handleDashboardV2Input, initialThemeFromEnv, v2CommandForKey } from "../dist/dashboard/v2Input.js";
import {
  v3CommandForKey,
  handleDashboardV3Input,
  initialRuntimeStateV3,
  paletteEntries,
  filterPalette,
  pushToast,
  expireToasts,
} from "../dist/dashboard/v3Input.js";
import { mutedTheme } from "../dist/dashboard/theme.js";
import { LogBuffer, formatLogEvent, parseLogChunk } from "../dist/dashboard/logEvents.js";
import {
  createDashboardViewModel,
  defaultCollapsedStatuses,
  fleetGridCells,
  formatDashboardLogLines,
  projectLabel,
  statusActivity,
  statusColor,
  triageBucketForStatus,
  triageGroups,
} from "../dist/dashboard/model.js";
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

// --- v3 -----------------------------------------------------------------

function v3State(overrides = {}) {
  const state = initialRuntimeStateV3(cyberpunkTheme);
  return { ...state, ...overrides };
}

function waitingPeerState(extra = {}) {
  return v3State({
    selectedPeerId: "p1",
    visiblePeers: [{ id: "p1", index: 0, status: "waiting", project: "repo/app", lastEvent: "run migration?", selected: true }],
    ...extra,
  });
}

function v3Actions(calls = { kill: [], reply: [], quit: 0, refresh: 0 }) {
  return {
    calls,
    refresh: () => { calls.refresh += 1; },
    quit: () => { calls.quit += 1; },
    killPeer: (peerId) => { calls.kill.push(peerId); return { id: peerId }; },
    sendPeerReply: (peerId, text) => { calls.reply.push({ peerId, text }); return { id: peerId }; },
  };
}

test("v3CommandForKey maps normal-mode keys", () => {
  const s = v3State();
  assert.equal(v3CommandForKey("1", s), "switch-route-1");
  assert.equal(v3CommandForKey("5", s), "switch-route-5");
  assert.equal(v3CommandForKey("j", s), "select-next");
  assert.equal(v3CommandForKey("\x1b[B", s), "select-next");
  assert.equal(v3CommandForKey("k", s), "select-prev");
  assert.equal(v3CommandForKey("h", s), "map-left");
  assert.equal(v3CommandForKey("l", s), "map-right");
  assert.equal(v3CommandForKey("\r", s), "open-modal");
  assert.equal(v3CommandForKey(" ", s), "open-modal");
  assert.equal(v3CommandForKey("\t", s), "toggle-drawer-focus");
  assert.equal(v3CommandForKey("\x1b[Z", s), "toggle-drawer-focus-prev");
  assert.equal(v3CommandForKey("`", s), "toggle-drawer");
  assert.equal(v3CommandForKey(":", s), "open-palette");
  assert.equal(v3CommandForKey("\x0b", s), "open-palette");
  assert.equal(v3CommandForKey("c", s), "toggle-status-group");
  assert.equal(v3CommandForKey("g", s), "jump-top");
  assert.equal(v3CommandForKey("G", s), "jump-bottom");
  assert.equal(v3CommandForKey("\x1b[5~", s), "page-up");
  assert.equal(v3CommandForKey("\x1b[6~", s), "page-down");
  assert.equal(v3CommandForKey("b", s), "log-bottom");
  assert.equal(v3CommandForKey("e", s), "jump-error");
  assert.equal(v3CommandForKey("a", s), "open-modal-answer");
  assert.equal(v3CommandForKey("x", s), "open-modal-kill");
  assert.equal(v3CommandForKey("t", s), "cycle-theme");
  assert.equal(v3CommandForKey("r", s), "refresh");
  assert.equal(v3CommandForKey("?", s), "help");
  assert.equal(v3CommandForKey("q", s), "quit");
  assert.equal(v3CommandForKey("\x03", s), "quit");
});

test("v3CommandForKey ctrl-c quits from every mode", () => {
  for (const mode of ["normal", "palette", "modal", "modal-answer", "modal-kill", "help"]) {
    assert.equal(v3CommandForKey("\x03", v3State({ mode })), "quit");
  }
});

test("v3CommandForKey maps modal-mode keys", () => {
  const s = v3State({ mode: "modal" });
  assert.equal(v3CommandForKey("\t", s), "modal-next-tab");
  assert.equal(v3CommandForKey("h", s), "modal-next-tab");
  assert.equal(v3CommandForKey("l", s), "modal-next-tab");
  assert.equal(v3CommandForKey("\x1b[Z", s), "modal-prev-tab");
  assert.equal(v3CommandForKey("\x1b[D", s), "modal-prev-button");
  assert.equal(v3CommandForKey("\x1b[C", s), "modal-next-button");
  assert.equal(v3CommandForKey("j", s), "modal-scroll-down");
  assert.equal(v3CommandForKey("k", s), "modal-scroll-up");
  assert.equal(v3CommandForKey("\r", s), "modal-activate");
  assert.equal(v3CommandForKey("a", s), "modal-answer");
  assert.equal(v3CommandForKey("v", s), "modal-view-log");
  assert.equal(v3CommandForKey("x", s), "modal-kill");
  assert.equal(v3CommandForKey("\x1b", s), "modal-close");
  assert.equal(v3CommandForKey("q", s), "modal-close");
});

test("v3CommandForKey maps modal-answer, modal-kill, palette, help modes", () => {
  assert.equal(v3CommandForKey("\r", v3State({ mode: "modal-answer" })), "submit-answer");
  assert.equal(v3CommandForKey("\x1b", v3State({ mode: "modal-answer" })), "cancel");
  assert.equal(v3CommandForKey("z", v3State({ mode: "modal-answer" })), "noop");
  assert.equal(v3CommandForKey("\r", v3State({ mode: "modal-kill" })), "modal-kill");
  assert.equal(v3CommandForKey("\x1b", v3State({ mode: "modal-kill" })), "cancel");
  assert.equal(v3CommandForKey("z", v3State({ mode: "modal-kill" })), "cancel");
  assert.equal(v3CommandForKey("\r", v3State({ mode: "palette" })), "palette-run");
  assert.equal(v3CommandForKey("\x1b", v3State({ mode: "palette" })), "palette-close");
  assert.equal(v3CommandForKey("\x1b[A", v3State({ mode: "palette" })), "palette-move-up");
  assert.equal(v3CommandForKey("\x10", v3State({ mode: "palette" })), "palette-move-up");
  assert.equal(v3CommandForKey("\x1b[B", v3State({ mode: "palette" })), "palette-move-down");
  assert.equal(v3CommandForKey("\x0e", v3State({ mode: "palette" })), "palette-move-down");
  assert.equal(v3CommandForKey("z", v3State({ mode: "palette" })), "noop");
  assert.equal(v3CommandForKey("\x1b", v3State({ mode: "help" })), "cancel");
  assert.equal(v3CommandForKey("?", v3State({ mode: "help" })), "cancel");
});

test("handleDashboardV3Input enter opens modal for selected peer", () => {
  const state = waitingPeerState();
  handleDashboardV3Input("\r", state, v3Actions());
  assert.equal(state.mode, "modal");
  assert.equal(state.modalPeerId, "p1");
  assert.equal(typeof state.modalOpenedAt, "number");
});

test("handleDashboardV3Input enter with no selection toasts instead of opening", () => {
  const state = v3State();
  handleDashboardV3Input("\r", state, v3Actions());
  assert.equal(state.mode, "normal");
  assert.equal(state.toasts.at(-1).text, "No peer selected");
});

test("handleDashboardV3Input a opens modal-answer only when waiting", () => {
  const waiting = waitingPeerState();
  handleDashboardV3Input("a", waiting, v3Actions());
  assert.equal(waiting.mode, "modal-answer");
  assert.equal(waiting.modalPeerId, "p1");

  const working = v3State({
    selectedPeerId: "p2",
    visiblePeers: [{ id: "p2", index: 0, status: "working", project: "repo/app", lastEvent: "x", selected: true }],
  });
  handleDashboardV3Input("a", working, v3Actions());
  assert.equal(working.mode, "normal");
  assert.match(working.toasts.at(-1).text, /not waiting/);
});

test("typed answer submits through sendPeerReply and closes modal with toast", () => {
  const state = waitingPeerState();
  const actions = v3Actions();
  handleDashboardV3Input("a", state, actions);
  handleDashboardV3Input("o", state, actions);
  handleDashboardV3Input("k", state, actions);
  handleDashboardV3Input("\r", state, actions);
  assert.deepEqual(actions.calls.reply, [{ peerId: "p1", text: "ok" }]);
  assert.equal(state.mode, "normal");
  assert.equal(state.modalPeerId, undefined);
  assert.match(state.toasts.at(-1).text, /Reply sent/);
});

test("x opens modal-kill and enter kills; esc disarms back to modal", () => {
  const disarm = waitingPeerState();
  handleDashboardV3Input("x", disarm, v3Actions());
  assert.equal(disarm.mode, "modal-kill");
  handleDashboardV3Input("\x1b", disarm, v3Actions());
  assert.equal(disarm.mode, "modal");

  const state = waitingPeerState();
  const actions = v3Actions();
  handleDashboardV3Input("x", state, actions);
  handleDashboardV3Input("\r", state, actions);
  assert.deepEqual(actions.calls.kill, ["p1"]);
  assert.equal(state.mode, "normal");
  assert.match(state.toasts.at(-1).text, /Killed p1/);
});

test("route switching via 1-5 sets route and focusChangedAt", () => {
  const state = v3State();
  handleDashboardV3Input("2", state, v3Actions());
  assert.equal(state.route, "map");
  assert.equal(typeof state.focusChangedAt, "number");
  handleDashboardV3Input("5", state, v3Actions());
  assert.equal(state.route, "alerts");
});

test("backtick toggles drawer", () => {
  const state = v3State();
  assert.equal(state.drawerOpen, true);
  handleDashboardV3Input("`", state, v3Actions());
  assert.equal(state.drawerOpen, false);
  handleDashboardV3Input("`", state, v3Actions());
  assert.equal(state.drawerOpen, true);
});

test("map-left/map-right move selection across projects", () => {
  const state = v3State({
    route: "map",
    selectedPeerId: "a1",
    visiblePeers: [
      { id: "a1", index: 0, status: "working", project: "alpha", lastEvent: "x", selected: true },
      { id: "b1", index: 1, status: "working", project: "beta", lastEvent: "x", selected: false },
    ],
  });
  handleDashboardV3Input("l", state, v3Actions());
  assert.equal(state.selectedPeerId, "b1");
  handleDashboardV3Input("h", state, v3Actions());
  assert.equal(state.selectedPeerId, "a1");
});

test("filterPalette does case-insensitive subsequence matching", () => {
  const entries = paletteEntries(waitingPeerState());
  assert.ok(entries.length > 0);
  const themeMatch = filterPalette(entries, "thm");
  assert.ok(themeMatch.some((e) => e.label.includes("theme")));
  assert.equal(filterPalette(entries, "zzzq").length, 0);
  assert.equal(filterPalette(entries, "").length, entries.length);
});

test("paletteEntries includes peer, answer, kill, routes, and actions", () => {
  const entries = paletteEntries(waitingPeerState()).map((e) => e.label);
  assert.ok(entries.some((l) => l.startsWith("▸ p1")));
  assert.ok(entries.some((l) => l === "↳ answer p1"));
  assert.ok(entries.some((l) => l === "✕ kill p1"));
  assert.ok(entries.some((l) => l === "route fleet"));
  assert.ok(entries.some((l) => l === "◐ theme"));
  assert.ok(entries.some((l) => l === "q quit"));
});

test("pushToast caps at 3 and expireToasts drops old ones", () => {
  const state = v3State();
  for (const t of ["a", "b", "c", "d", "e"]) {
    pushToast(state, t, "info");
  }
  assert.equal(state.toasts.length, 3);
  assert.deepEqual(state.toasts.map((t) => t.text), ["c", "d", "e"]);

  state.toasts[0].createdAt = Date.now() - 5000;
  expireToasts(state, Date.now());
  assert.equal(state.toasts.length, 2);
});

test("mutedTheme maps colors, memoizes, and leaves ramp/cyanBand/chip fields on both themes", () => {
  for (const theme of [defaultTheme, cyberpunkTheme]) {
    assert.equal(theme.ramp.length, 3);
    assert.match(theme.cyanBand, /^#/);
    assert.match(theme.chipBg, /^#/);
    assert.match(theme.chipFg, /^#/);
  }
  const m = mutedTheme(cyberpunkTheme);
  assert.equal(m.text, "#2a1808");
  assert.equal(m.accent, "#2a1808");
  assert.equal(m.border, "#1a1006");
  assert.equal(m.selBg, "#0d0702");
  assert.equal(m.statusColors.working, "#3a2410");
  // original untouched
  assert.equal(cyberpunkTheme.text, "#ffb066");
  // memoized: same object identity
  assert.equal(mutedTheme(cyberpunkTheme), m);
  assert.notEqual(mutedTheme(defaultTheme), m);
});

const ALL_DASHBOARD_STATUSES = [
  "starting", "working", "waiting", "idle", "done", "failed", "frozen", "killed",
  "gsd_pending", "gsd_running_phase", "gsd_polling_state", "gsd_running_gate_check",
  "gsd_halted_on_gate_failure", "gsd_completed", "gsd_failed", "cleanup",
];

test("triageBucketForStatus maps every DashboardStatus to one of the 5 buckets", () => {
  const valid = new Set(["working", "waiting", "starting", "failed", "done"]);
  for (const status of ALL_DASHBOARD_STATUSES) {
    assert.ok(valid.has(triageBucketForStatus(status)), `unexpected bucket for ${status}`);
  }
});

test("triageBucketForStatus folds GSD statuses per A1", () => {
  assert.equal(triageBucketForStatus("gsd_running_phase"), "working");
  assert.equal(triageBucketForStatus("gsd_polling_state"), "working");
  assert.equal(triageBucketForStatus("gsd_running_gate_check"), "working");
  assert.equal(triageBucketForStatus("failed"), "failed");
  assert.equal(triageBucketForStatus("frozen"), "failed");
  assert.equal(triageBucketForStatus("gsd_halted_on_gate_failure"), "failed");
  assert.equal(triageBucketForStatus("gsd_failed"), "failed");
  assert.equal(triageBucketForStatus("killed"), "failed");
  assert.equal(triageBucketForStatus("done"), "done");
  assert.equal(triageBucketForStatus("cleanup"), "done");
  assert.equal(triageBucketForStatus("gsd_completed"), "done");
  assert.equal(triageBucketForStatus("idle"), "done");
  assert.equal(triageBucketForStatus("gsd_pending"), "done");
  assert.equal(triageBucketForStatus("waiting"), "waiting");
  assert.equal(triageBucketForStatus("starting"), "starting");
});

test("triageGroups yields buckets in exact WORKING, WAITING, STARTING, FAILED, DONE order", () => {
  const view = createDashboardViewModel([
    peer({ id: "w1", status: "working" }),
    peer({ id: "wait1", status: "waiting" }),
    peer({ id: "s1", status: "starting" }),
    peer({ id: "f1", status: "failed" }),
    peer({ id: "d1", status: "done" }),
  ], {}, { now: new Date("2026-05-07T12:05:00Z") });

  const groups = triageGroups(view.peers);
  assert.deepEqual(groups.map((g) => g.bucket), ["working", "waiting", "starting", "failed", "done"]);
  assert.equal(groups.find((g) => g.bucket === "working").peers[0].id, "w1");
  assert.equal(groups.find((g) => g.bucket === "waiting").peers[0].id, "wait1");
  assert.equal(groups.find((g) => g.bucket === "starting").peers[0].id, "s1");
  assert.equal(groups.find((g) => g.bucket === "failed").peers[0].id, "f1");
  assert.equal(groups.find((g) => g.bucket === "done").peers[0].id, "d1");
});

test("createDashboardViewModel threads context fields onto rows, undefined when unmeasured", () => {
  const view = createDashboardViewModel([
    peer({ id: "measured", status: "working", contextPercent: 42, contextLevel: "yellow", compacted: true }),
    peer({ id: "unmeasured", status: "working" }),
  ], {}, { now: new Date("2026-05-07T12:05:00Z") });

  const measured = view.peers.find((row) => row.id === "measured");
  assert.equal(measured.contextPercent, 42);
  assert.equal(measured.contextLevel, "yellow");
  assert.equal(measured.compacted, true);

  const unmeasured = view.peers.find((row) => row.id === "unmeasured");
  assert.equal(unmeasured.contextPercent, undefined);
  assert.equal(unmeasured.contextLevel, undefined);
  assert.equal(unmeasured.compacted, undefined);
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
