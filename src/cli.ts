import { readFileSync } from "node:fs";
import { killPeer, listPeers, peerStatus, readPeerLog, resumePeer, spawnPeer } from "./peerManager.js";

export async function runCliCommand(command: string, argv: string[]): Promise<void> {
  switch (command) {
    case "spawn": {
      const args = parseFlags(argv);
      const prompt = flagString(args, "prompt") || readStdin();
      const repo = flagString(args, "repo");
      if (!repo || !prompt) {
        throw new Error("Usage: delamain spawn --repo <git-repo> --prompt <task> [--name <name>] [--start-ref <ref>] [--merge-branch <branch>] [--engine codex|cursor] [--model <model>] [--yolo]");
      }
      console.log(JSON.stringify(spawnPeer({
        repo,
        prompt,
        name: flagString(args, "name"),
        startRef: flagString(args, "start-ref"),
        mergeBranch: flagString(args, "merge-branch"),
        targetBranch: flagString(args, "target-branch"),
        model: flagString(args, "model"),
        sandbox: flagString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
        engine: flagString(args, "engine") as "codex" | "cursor" | undefined,
        cursorOptions: buildCursorOptions(args),
      }), null, 2));
      return;
    }
    case "resume": {
      const [peerId, ...rest] = argv;
      const args = parseFlags(rest);
      const prompt = flagString(args, "prompt") || readStdin();
      if (!peerId || !prompt) {
        throw new Error("Usage: delamain resume <peer-id> --prompt <message>");
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
        throw new Error("Usage: delamain status <peer-id>");
      }
      console.log(JSON.stringify(peerStatus(peerId), null, 2));
      return;
    }
    case "log": {
      const peerId = argv[0];
      if (!peerId) {
        throw new Error("Usage: delamain log <peer-id> [lines]");
      }
      console.log(readPeerLog(peerId, Number(argv[1]) || 120));
      return;
    }
    case "kill": {
      const peerId = argv[0];
      if (!peerId) {
        throw new Error("Usage: delamain kill <peer-id> [SIGTERM|SIGKILL]");
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

function buildCursorOptions(
  args: Record<string, string | boolean>,
): { cloud?: boolean; approveMcps?: boolean; force?: boolean } | undefined {
  const cloud = Boolean(args["cursor-cloud"]);
  const approveMcps = Boolean(args["cursor-approve-mcps"]);
  const force = args["no-cursor-force"] ? false : undefined;
  if (!cloud && !approveMcps && force === undefined) {
    return undefined;
  }
  return {
    cloud: cloud || undefined,
    approveMcps: approveMcps || undefined,
    force,
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function printHelp(): void {
  console.log(`delamain — multi-engine peer supervisor

Commands:
  server                         Start the MCP server over stdio
  dashboard                      Run the live terminal dashboard
  dashboard-v2                   Run the v2 grid terminal dashboard
  --d, -d                        Run the live terminal dashboard
  --d2, -d2                      Run the v2 grid terminal dashboard
  tmux-status                    Print one tmux status-line summary
  spawn --repo <git-repo> --prompt <task> [--start-ref <ref>] [--merge-branch <branch>] [--target-branch <branch>] [--engine codex|cursor] [--model <model>] [--sandbox <mode>] [--yolo]
        cursor engine: [--cursor-cloud] [--cursor-approve-mcps] [--no-cursor-force]
  resume <peer-id> --prompt <message> [--model <model>] [--yolo]
  list
  status <peer-id>
  log <peer-id> [lines]
  kill <peer-id> [SIGTERM|SIGKILL]

Codex MCP registration:
  codex mcp add delamain -- node $(pwd)/dist/index.js server

tmux status-line:
  set -g status-right '#(delamain tmux-status)'

Aliases:
  --yolo is accepted as shorthand for Codex's
  --dangerously-bypass-approvals-and-sandbox

Spawn behavior:
  New peers require a Git repository with origin. Each peer runs on a
  codex-peer/<id> branch in a linked worktree under DELAMAIN_HOME (legacy
  CODEX_PEERS_HOME env var still accepted), then successful work is
  committed if needed, merged with --merge-branch or the
  origin default branch, and pushed back to that branch. Use --start-ref to
  choose the commit/ref used to create the worktree. The older --target-branch
  option still means both --start-ref origin/<branch> and --merge-branch
  <branch> when the newer flags are not supplied.
`);
}
