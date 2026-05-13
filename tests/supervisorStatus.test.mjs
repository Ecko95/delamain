import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSupervisorTelegramStatus } from "../dist/supervisorStatus.js";

test("readSupervisorTelegramStatus matches selected peer by current_peer_id", () => {
  const home = mkdtempSync(join(tmpdir(), "supervisor-status-"));
  const dir = join(home, "roadmap-a");
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    halted: false,
    current_slice_id: "44",
    current_peer_id: "peer123",
    current_merge_branch: "autopilot/phase-44",
    notified_events: ["spawn:peer123"],
    history: [{ slice_id: "44", peer_id: "peer123", merge_branch: "autopilot/phase-44", outcome: null }],
  }));
  writeFileSync(join(dir, "logs", "supervisor-2026-05-13.log"), "2026-05-13T14:35:04Z [autopilot] tick complete\n");

  const status = readSupervisorTelegramStatus("peer123", { home });
  assert.equal(status.level, "sent");
  assert.equal(status.icon, "✅");
  assert.equal(status.roadmap, "roadmap-a");
  assert.equal(status.sliceId, "44");
  assert.equal(status.latestLogAt, "2026-05-13T14:35:04Z");
});

test("readSupervisorTelegramStatus matches selected peer by history", () => {
  const home = mkdtempSync(join(tmpdir(), "supervisor-status-history-"));
  const dir = join(home, "roadmap-b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    halted: false,
    current_slice_id: "45",
    current_peer_id: "peer456",
    notified_events: ["spawn:old123", "merged:old123", "spawn:peer456"],
    history: [{ slice_id: "44", peer_id: "old123", merge_branch: "autopilot/phase-44", outcome: "merged" }],
  }));

  const status = readSupervisorTelegramStatus("old123", { home });
  assert.equal(status.level, "sent");
  assert.equal(status.lastNotification, "merged:old123");
  assert.equal(status.sliceId, "44");
});

test("readSupervisorTelegramStatus maps waiting and halted notification states", () => {
  const home = mkdtempSync(join(tmpdir(), "supervisor-status-waiting-"));
  const waitingDir = join(home, "roadmap-waiting");
  const haltedDir = join(home, "roadmap-halted");
  mkdirSync(waitingDir, { recursive: true });
  mkdirSync(haltedDir, { recursive: true });
  writeFileSync(join(waitingDir, "state.json"), JSON.stringify({
    halted: false,
    current_peer_id: "wait123",
    notified_events: ["waiting:wait123:item.completed"],
    history: [],
  }));
  writeFileSync(join(haltedDir, "state.json"), JSON.stringify({
    halted: true,
    halted_reason: "tests failed",
    current_peer_id: "halt123",
    notified_events: ["failed:halt123"],
    history: [],
  }));

  assert.equal(readSupervisorTelegramStatus("wait123", { home }).level, "waiting");
  assert.equal(readSupervisorTelegramStatus("halt123", { home }).level, "halted");
  assert.equal(readSupervisorTelegramStatus("missing", { home }).level, "unknown");
});
