import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmuxStatusLine } from "./peerManager.js";

export { projectLabel } from "./dashboard/model.js";

export function startDashboard(): void {
  startDashboardEntry("bunEntry.js");
}

export function startDashboardV2(): void {
  startDashboardEntry("bunEntryV2.js");
}

function startDashboardEntry(entryFile: string): void {
  const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bunCheck.error || bunCheck.status !== 0) {
    throw new Error(bunMissingMessage());
  }

  const entry = join(dirname(fileURLToPath(import.meta.url)), "dashboard", entryFile);
  try {
    accessSync(entry, constants.R_OK);
  } catch {
    throw new Error(`Dashboard entry not found at ${entry}. Run npm run build and retry.`);
  }

  const result = spawnSync("bun", [entry], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw new Error(`Failed to launch Bun dashboard: ${result.error.message}`);
  }
  if (typeof result.signal === "string") {
    process.kill(process.pid, result.signal);
  }
  if (typeof result.status === "number") {
    process.exitCode = result.status;
  }
}

export function printTmuxStatus(): void {
  console.log(tmuxStatusLine());
}

export function bunMissingMessage(): string {
  return [
    "OpenTUI dashboard requires Bun for now.",
    "Reason: @opentui/core@0.2.4 fails under Node ESM when loading bundled .scm assets.",
    "Install Bun from https://bun.sh/docs/installation, then rerun codex-peers --d, --d2, or codex-peers dashboard.",
    "Node-based commands remain available: codex-peers server, codex-peers list, codex-peers tmux-status, codex-peers log <peer-id>.",
  ].join("\n");
}
