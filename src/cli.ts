import { readFileSync } from "node:fs";
import { killPeer, listPeers, peerStatus, readPeerLog, resumePeer, spawnPeer } from "./peerManager.js";

export async function runCliCommand(command: string, argv: string[]): Promise<void> {
  switch (command) {
    case "spawn": {
      const args = parseFlags(argv);
      const prompt = flagString(args, "prompt") || readStdin();
      const repo = flagString(args, "repo");
      if (!repo || !prompt) {
        throw new Error("Usage: codex-peers spawn --repo <git-repo> --prompt <task> [--name <name>] [--yolo]");
      }
      console.log(JSON.stringify(spawnPeer({
        repo,
        prompt,
        name: flagString(args, "name"),
        model: flagString(args, "model"),
        sandbox: flagString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
      }), null, 2));
      return;
    }
    case "resume": {
      const [peerId, ...rest] = argv;
      const args = parseFlags(rest);
      const prompt = flagString(args, "prompt") || readStdin();
      if (!peerId || !prompt) {
        throw new Error("Usage: codex-peers resume <peer-id> --prompt <message>");
      }
      console.log(JSON.stringify(resumePeer({ peerId, prompt, model: flagString(args, "model"), yolo: bypassEnabled(args) }), null, 2));
      return;
    }
    case "list":
      console.log(JSON.stringify(listPeers(), null, 2));
      return;
    case "status": {
      const peerId = argv[0];
      if (!peerId) {
        throw new Error("Usage: codex-peers status <peer-id>");
      }
      console.log(JSON.stringify(peerStatus(peerId), null, 2));
      return;
    }
    case "log": {
      const peerId = argv[0];
      if (!peerId) {
        throw new Error("Usage: codex-peers log <peer-id> [lines]");
      }
      console.log(readPeerLog(peerId, Number(argv[1]) || 120));
      return;
    }
    case "kill": {
      const peerId = argv[0];
      if (!peerId) {
        throw new Error("Usage: codex-peers kill <peer-id> [SIGTERM|SIGKILL]");
      }
      console.log(JSON.stringify(killPeer(peerId, argv[1] === "SIGKILL" ? "SIGKILL" : "SIGTERM"), null, 2));
      return;
    }
    case "help":
    default:
      printHelp();
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function flagString(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function bypassEnabled(args: Record<string, string | boolean>): boolean {
  return Boolean(args.yolo || args["dangerously-bypass-approvals-and-sandbox"]);
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function printHelp(): void {
  console.log(`codex-peers

Commands:
  server                         Start the MCP server over stdio
  dashboard                      Run the live terminal dashboard
  tmux-status                    Print one tmux status-line summary
  spawn --repo <git-repo> --prompt <task> [--yolo]
  resume <peer-id> --prompt <message> [--yolo]
  list
  status <peer-id>
  log <peer-id> [lines]
  kill <peer-id> [SIGTERM|SIGKILL]

Codex MCP registration:
  codex mcp add codex-peers -- node $(pwd)/dist/index.js server

tmux status-line:
  set -g status-right '#(codex-peers tmux-status)'

Aliases:
  --yolo is accepted as shorthand for Codex's
  --dangerously-bypass-approvals-and-sandbox

Spawn behavior:
  New peers require a Git repository with origin/main. Each peer runs on a
  codex-peer/<id> branch in a linked worktree under CODEX_PEERS_HOME, then
  successful work is committed if needed, merged with origin/main, and pushed
  to origin/main.
`);
}
