#!/usr/bin/env node
import { startDashboard, printTmuxStatus } from "./dashboard.js";
import { startMcpServer } from "./mcpServer.js";
import { runPeer } from "./runner.js";
import { runCliCommand } from "./cli.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "--d":
    case "-d":
      startDashboard();
      return;
    case "server":
      await startMcpServer();
      return;
    case "dashboard":
      startDashboard();
      return;
    case "tmux-status":
      printTmuxStatus();
      return;
    case "run-peer":
      await runPeer(args);
      return;
    default:
      await runCliCommand(command, args);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
