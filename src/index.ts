#!/usr/bin/env node
import { startDashboard, printTmuxStatus } from "./dashboard.js";
import { startMcpServer } from "./mcpServer.js";
import { runPeer } from "./runner.js";
import { runCliCommand } from "./cli.js";
import { runWorkflowRunnerChild } from "./workflow/manager.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "--d":
    case "-d":
    case "--d2":
    case "-d2":
    case "dashboard":
    case "dashboard-v2":
      startDashboard();
      return;
    case "server":
      await startMcpServer();
      return;
    case "tmux-status":
      printTmuxStatus();
      return;
    case "run-peer":
      await runPeer(args);
      return;
    case "run-workflow-runner":
      await runWorkflowRunnerChild(args);
      return;
    default:
      await runCliCommand(command, args);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
