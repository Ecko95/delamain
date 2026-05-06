import { homedir } from "node:os";
import { join } from "node:path";

export function peersHome(): string {
  return process.env.CODEX_PEERS_HOME || join(homedir(), ".codex-peers");
}

export function statePath(): string {
  return join(peersHome(), "state.json");
}

export function runsDir(): string {
  return join(peersHome(), "runs");
}

export function promptsDir(): string {
  return join(peersHome(), "prompts");
}
