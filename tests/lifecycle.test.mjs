import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { terminalResponseStateFromLog } from "../dist/lifecycle.js";
import { peerStatus, tmuxStatusLine } from "../dist/peerManager.js";

test("terminal response ignores stale waiting markers embedded in command output", () => {
  const state = terminalResponseStateFromLog(
    [
      agentMessage("CODEX_PEERS_STATUS: WAITING\nQUESTION: Use Bun or fallback?"),
      commandExecution(
        JSON.stringify({
          status: "waiting",
          question: "CODEX_PEERS_STATUS: WAITING\nQUESTION: Use Bun or fallback?",
        }),
      ),
      agentMessage("Implemented and committed the resumed work.\n\nVerified: npm test passed."),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n"),
  );

  assert.equal(state.sawAgentMessage, true);
  assert.equal(state.waitingQuestion, undefined);
});

test("terminal response keeps a legitimate final waiting question", () => {
  const state = terminalResponseStateFromLog(
    [
      agentMessage("I need one decision before continuing."),
      agentMessage("CODEX_PEERS_STATUS: WAITING\nQUESTION: Should I use Bun for the dashboard?"),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n"),
  );

  assert.equal(state.sawAgentMessage, true);
  assert.equal(state.waitingQuestion, "Should I use Bun for the dashboard?");
});

test("peer status reconciles stale finished waiting records from the terminal log", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-peers-lifecycle-"));
  const previousHome = process.env.CODEX_PEERS_HOME;
  try {
    const home = join(root, "home");
    const logPath = join(root, "peer.log");
    process.env.CODEX_PEERS_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      logPath,
      [
        agentMessage("CODEX_PEERS_STATUS: WAITING\nQUESTION: Use Bun or fallback?"),
        commandExecution("old peer JSON still says CODEX_PEERS_STATUS: WAITING QUESTION: Use Bun or fallback?"),
        agentMessage("Implemented and committed the resumed work.\n\nVerified: npm test passed."),
        JSON.stringify({ type: "turn.completed" }),
        "[delamain] exited code=0 signal=",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-05-07T16:00:00.000Z",
          peers: [
            {
              id: "stale123",
              repo: process.cwd(),
              task: "resume dashboard work",
              status: "waiting",
              integrationStatus: "pending",
              startedAt: "2026-05-07T15:00:00.000Z",
              updatedAt: "2026-05-07T16:00:00.000Z",
              finishedAt: "2026-05-07T16:00:00.000Z",
              exitCode: 0,
              signal: null,
              logPath,
              lastEvent: "waiting for orchestrator input",
              question: "Use Bun or fallback?",
              finalResult:
                "CODEX_PEERS_STATUS: WAITING QUESTION: Use Bun or fallback? Implemented and committed the resumed work.",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const peer = peerStatus("stale123");

    assert.equal(peer.status, "done");
    assert.equal(peer.question, undefined);
    assert.match(peer.lastEvent ?? "", /stale waiting status reconciled/);
    assert.equal(tmuxStatusLine(), "Codex peers: 1 | working 0 | waiting 0 | cleanup 0 | frozen 0");
  } finally {
    if (previousHome === undefined) {
      delete process.env.CODEX_PEERS_HOME;
    } else {
      process.env.CODEX_PEERS_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function agentMessage(text) {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id: "agent",
      type: "agent_message",
      text,
    },
  });
}

function commandExecution(output) {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id: "command",
      type: "command_execution",
      command: "codex-peers list",
      aggregated_output: output,
      exit_code: 0,
      status: "completed",
    },
  });
}
