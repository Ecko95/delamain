import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexUsage, usageFromRateLimitEvent, usageLevel } from "../dist/codexUsage.js";

test("usageLevel classifies remaining quota thresholds", () => {
  assert.equal(usageLevel(100), "green");
  assert.equal(usageLevel(75), "green");
  assert.equal(usageLevel(74), "yellow");
  assert.equal(usageLevel(40), "yellow");
  assert.equal(usageLevel(39), "red");
  assert.equal(usageLevel(20), "red");
  assert.equal(usageLevel(19), "skull");
});

test("usageFromRateLimitEvent renders 5h and weekly windows as remaining quota", () => {
  const usage = usageFromRateLimitEvent({
    type: "codex.rate_limits",
    plan_type: "pro",
    rate_limits: {
      primary: { used_percent: 31, window_minutes: 300, reset_at: 1778352617 },
      secondary: { used_percent: 82, window_minutes: 10080, reset_at: 1778957417 },
    },
  });

  assert.equal(usage?.planType, "pro");
  assert.deepEqual(usage?.limits.map((limit) => [limit.label, limit.remainingPercent, limit.level]), [
    ["5h", 69, "yellow"],
    ["weekly", 18, "skull"],
  ]);
});

test("readCodexUsage scans local Codex logs for the newest rate-limit event", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-test-"));
  mkdirSync(join(home, "log"));
  writeFileSync(join(home, "log", "codex-tui.log"), [
    "noise",
    'websocket event: {"type":"codex.rate_limits","plan_type":"free","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":11,"window_minutes":10080,"reset_at":1778352617},"secondary":null}}',
  ].join("\n"));

  const usage = readCodexUsage({ home });
  assert.deepEqual(usage?.limits.map((limit) => [limit.label, limit.remainingPercent, limit.level]), [
    ["weekly", 89, "green"],
  ]);
});

test("readCodexUsage prefers Codex session JSONL rate limits", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-session-test-"));
  const sessionDir = join(home, "sessions", "2026", "05", "13");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "rollout.jsonl"), JSON.stringify({
    timestamp: "2026-05-13T13:59:05.811Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 3, window_minutes: 300, resets_at: 1778691906 },
        secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1779227526 },
        plan_type: "pro",
      },
    },
  }));

  const usage = readCodexUsage({ home });
  assert.equal(usage?.planType, "pro");
  assert.deepEqual(usage?.limits.map((limit) => [limit.label, limit.remainingPercent, limit.level]), [
    ["5h", 97, "green"],
    ["weekly", 39, "red"],
  ]);
});
