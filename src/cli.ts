import { readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { killPeer, listPeers, peerStatus, readPeerLog, resumePeer, sendPeerMessage, spawnPeer } from "./peerManager.js";
import { refreshAllMergeStates, refreshMergeState } from "./mergeState.js";
import { getPeer } from "./store.js";
import { pidAlive } from "./processes.js";
import { readPeerCost } from "./peerCost.js";
import { readPeerInbox } from "./peerInbox.js";
import { sweepPeers } from "./sweep.js";
import { runWaitCommand, WAIT_USAGE } from "./wait.js";
import { wavesView } from "./waves.js";
import { resumeWorkflowRun, spawnWorkflowRun, spawnWorkflowRunner, workflowStatus } from "./workflow/manager.js";
import { validateWorkflowSource } from "./workflow/sandbox.js";
import { TERMINAL_PEER_STATUSES } from "./types.js";

export async function runCliCommand(command: string, argv: string[]): Promise<void> {
  switch (command) {
    case "spawn": {
      const args = parseFlags(argv);
      const prompt = flagString(args, "prompt") || readStdin();
      const repo = flagString(args, "repo");
      if (!repo || !prompt) {
        throw new Error("Usage: delamain spawn --repo <git-repo> --prompt <task> [--name <name>] [--start-ref <ref>] [--merge-branch <branch>] [--engine codex|cursor] [--model <model>] [--yolo] [--depends-on <peer-id,peer-id>] [--claims <path,path:ro>] [--claims-override]");
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
        dependsOn: flagString(args, "depends-on")?.split(",").map((s) => s.trim()).filter(Boolean),
        claims: flagString(args, "claims")?.split(",").map((s) => s.trim()).filter(Boolean),
        claimsOverride: Boolean(args["claims-override"]),
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
    case "merge-state": {
      const peerId = argv[0];
      if (peerId) {
        const peer = getPeer(peerId);
        if (!peer) throw new Error(`No peer matching ${peerId}`);
        const next = refreshMergeState(peer);
        console.log(JSON.stringify(next ?? { unchanged: true, id: peer.id, integrationStatus: peer.integrationStatus }, null, 2));
        return;
      }
      console.log(JSON.stringify(refreshAllMergeStates(), null, 2));
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
    case "wait": {
      const args = parseWaitArgs(argv);
      if (args.help) {
        console.log(WAIT_USAGE);
        return;
      }
      const exitCode = await runWaitCommand(args.peerIds, {
        any: args.any,
        intervalMs: args.intervalSeconds * 1000,
        timeoutMs: args.timeoutSeconds * 1000,
      });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      return;
    }
    case "send": {
      const args = parseFlags(argv);
      const to = flagString(args, "to");
      const message = flagString(args, "message") || readStdin();
      if (!to || !message) {
        throw new Error("Usage: delamain send --to <peer-id> --message <text> [--from <peer-id>] [--expect-reply] [--response-id <id>]");
      }
      const from = flagString(args, "from") || inferSelfPeerId();
      const { responseId, delivery } = sendPeerMessage({
        fromPeerId: from,
        toPeerId: to,
        message,
        expectReply: Boolean(args["expect-reply"]),
        responseId: flagString(args, "response-id"),
      });
      console.log(JSON.stringify({ response_id: responseId ?? null, delivery }, null, 2));
      return;
    }
    case "inbox": {
      const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
      const args = parseFlags(positional ? argv.slice(1) : argv);
      const peerId = positional || inferSelfPeerId();
      console.log(JSON.stringify(readPeerInbox(peerId, { includeDelivered: Boolean(args.all) }), null, 2));
      return;
    }
    case "sweep": {
      const args = parseFlags(argv);
      const olderThan = flagString(args, "older-than");
      let olderThanDays: number | undefined;
      if (olderThan !== undefined) {
        olderThanDays = Number(olderThan);
        if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
          throw new Error("--older-than must be a non-negative number of days");
        }
      }
      const result = sweepPeers({
        olderThanDays,
        dryRun: Boolean(args["dry-run"]),
      });
      console.log(JSON.stringify({
        archived: result.archived.map((p) => p.id),
        markedDead: result.markedDead.map((p) => p.id),
        kept: result.kept,
        dryRun: Boolean(args["dry-run"]),
      }, null, 2));
      return;
    }
    case "cost": {
      const peerId = argv[0];
      let targets;
      if (peerId) {
        const peer = getPeer(peerId);
        if (!peer) throw new Error(`No peer matching ${peerId}`);
        targets = [peer];
      } else {
        targets = listPeers();
      }
      const rows = targets.map((p) => readPeerCost(p));
      const total = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
      console.log(JSON.stringify({ peers: rows, totalUsd: Math.round(total * 100) / 100 }, null, 2));
      return;
    }
    case "waves": {
      const view = wavesView(listPeers());
      console.log(JSON.stringify({
        running: view.running.map((p) => ({ id: p.id, task: p.task })),
        awaitingIntegration: view.awaitingIntegration.map((p) => ({ id: p.id, task: p.task })),
        mergeReady: view.mergeReady.map((p) => ({ id: p.id, pr: p.integrationPrUrl })),
        mergeBlocked: view.mergeBlocked.map((x) => ({ id: x.peer.id, blockers: x.blockers })),
        merged: view.merged.map((p) => ({ id: p.id, sha: p.integrationMergeCommitSha })),
        claimConflicts: view.claimConflicts,
      }, null, 2));
      return;
    }
    case "run-workflow": {
      const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
      const args = parseFlags(positional ? argv.slice(1) : argv);
      // Resume an existing run: replay its journaled prefix, run the rest live.
      const resumeId = flagString(args, "resume");
      let run: ReturnType<typeof spawnWorkflowRun>;
      if (resumeId) {
        run = resumeWorkflowRun(resumeId);
      } else {
        const scriptPath = positional || flagString(args, "script");
        if (!scriptPath) {
          throw new Error("Usage: delamain run-workflow <file> [--timeout-ms <ms>] [--max-agents <n>] [--budget-tokens <n>] [--repo <git-repo>] [--name <name>] [--detach]  |  delamain run-workflow --resume <workflow-id>");
        }
        const timeoutMs = positiveFlag(args, "timeout-ms", "milliseconds");
        const maxAgents = positiveFlag(args, "max-agents", "leaves");
        const budgetTokens = positiveFlag(args, "budget-tokens", "tokens");
        // Fail fast on a rejected script before persisting the run record; the
        // sandbox re-validates the same source at execution time.
        validateWorkflowSource(readFileSync(scriptPath, "utf8"), scriptPath);
        run = spawnWorkflowRun({
          repo: flagString(args, "repo") || process.cwd(),
          scriptPath,
          timeoutMs,
          maxAgents,
          budgetTokens,
          name: flagString(args, "name"),
        });
        spawnWorkflowRunner(run.id);
      }
      if (args.detach) {
        console.log(JSON.stringify({ workflow_id: run.id, status: run.status, workflow: run.workflow }, null, 2));
        return;
      }
      const final = await waitForWorkflowRun(run.id);
      console.log(
        JSON.stringify(
          {
            workflow_id: final.peer.id,
            status: final.peer.status,
            workflow_status: final.peer.workflow?.status,
            result: final.peer.workflow?.result ?? null,
            error: final.peer.workflow?.error ?? final.peer.error,
            agent_peer_ids: final.peer.workflow?.agentPeerIds ?? [],
            replayed_agents: final.peer.workflow?.replayedAgents ?? 0,
            ...(final.diedEarly ? { runner_died: true } : {}),
          },
          null,
          2,
        ),
      );
      if (final.peer.workflow?.status !== "done") {
        process.exitCode = 1;
      }
      return;
    }
    case "workflow": {
      const workflowId = argv[0];
      if (!workflowId) {
        throw new Error("Usage: delamain workflow <workflow-id>");
      }
      console.log(JSON.stringify(workflowStatus(workflowId), null, 2));
      return;
    }
    case "help":
    default:
      printHelp();
  }
}

function positiveFlag(args: Record<string, string | boolean>, key: string, unit: string): number | undefined {
  const raw = flagString(args, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${key} must be a positive number of ${unit}`);
  }
  return value;
}

// Poll the store until the detached workflow runner drives the record to a
// terminal status (or dies without doing so).
async function waitForWorkflowRun(workflowId: string): Promise<{ peer: NonNullable<ReturnType<typeof getPeer>>; diedEarly: boolean }> {
  for (;;) {
    const peer = getPeer(workflowId);
    if (!peer) {
      throw new Error(`workflow ${workflowId} disappeared from the store`);
    }
    if (TERMINAL_PEER_STATUSES.has(peer.status)) {
      return { peer, diedEarly: false };
    }
    if (peer.runnerPid && !pidAlive(peer.runnerPid)) {
      // One grace re-read: the runner may have exited between its final
      // store write and this poll.
      await delay(500);
      const settled = getPeer(workflowId);
      if (settled && TERMINAL_PEER_STATUSES.has(settled.status)) {
        return { peer: settled, diedEarly: false };
      }
      return { peer: settled ?? peer, diedEarly: true };
    }
    await delay(1000);
  }
}

// Infer the caller's own peer id by matching cwd against each peer's worktreePath
// (realpath both sides so symlinked worktrees resolve). Errors clearly on no match.
function inferSelfPeerId(): string {
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    cwd = process.cwd();
  }
  const match = listPeers().find((peer) => {
    if (!peer.worktreePath) {
      return false;
    }
    try {
      return realpathSync(peer.worktreePath) === cwd;
    } catch {
      return false;
    }
  });
  if (!match) {
    throw new Error(
      `Could not infer your peer identity from cwd (${cwd}); no peer's worktreePath matches. Pass --from <peer-id> / <peer-id> explicitly.`,
    );
  }
  return match.id;
}

function parseWaitArgs(argv: string[]): {
  peerIds: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  any: boolean;
  help: boolean;
} {
  const peerIds: string[] = [];
  let intervalSeconds = 15;
  let timeoutSeconds = 0;
  let any = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--any") {
      any = true;
    } else if (arg === "--interval" || arg === "--timeout") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${arg} requires a value in seconds`);
      }
      const value = Number(next);
      if (!Number.isFinite(value) || value < 0 || (arg === "--interval" && value === 0)) {
        throw new Error(`${arg} must be ${arg === "--interval" ? "greater than" : "at least"} 0 seconds`);
      }
      if (arg === "--interval") {
        intervalSeconds = value;
      } else {
        timeoutSeconds = value;
      }
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown wait option: ${arg}`);
    } else {
      peerIds.push(arg);
    }
  }

  if (!help && peerIds.length === 0) {
    throw new Error(WAIT_USAGE);
  }

  return { peerIds, intervalSeconds, timeoutSeconds, any, help };
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
  spawn --repo <git-repo> --prompt <task> [--start-ref <ref>] [--merge-branch <branch>] [--target-branch <branch>] [--engine codex|cursor] [--model <model>] [--sandbox <mode>] [--yolo] [--depends-on <peer-id,peer-id>] [--claims <path,path:ro>] [--claims-override]
        cursor engine: [--cursor-cloud] [--cursor-approve-mcps] [--no-cursor-force]
  resume <peer-id> --prompt <message> [--model <model>] [--yolo]
  list
  status <peer-id>
  merge-state [peer-id]          Refresh merged/closed state of pushed PRs via gh
  log <peer-id> [lines]
  kill <peer-id> [SIGTERM|SIGKILL]
  wait <peer-id...> [--interval <seconds>] [--timeout <seconds>] [--any]
  run-workflow <file> [--timeout-ms <ms>] [--max-agents <n>] [--budget-tokens <n>] [--repo <git-repo>] [--name <name>] [--detach]
                                 Run a sandboxed workflow (ctx.agent/parallel/pipeline leaves, integrate:false, OS-jailed)
  run-workflow --resume <workflow-id>
                                 Resume a workflow: replay its journaled agent prefix, run the rest live
  workflow <workflow-id>         Print a workflow run record as JSON
  send --to <peer-id> --message <text> [--from <peer-id>] [--expect-reply] [--response-id <id>]
  inbox [<peer-id>] [--all]
  sweep [--dry-run] [--older-than <days>]  Archive stale terminal peers; mark dead-pid stale peers failed
  waves                          Fleet readiness: running / merge-ready / merge-blocked / conflicts
  cost [peer-id]                 Notional token cost per peer from codex rollout logs

Peer-to-peer messaging:
  send/inbox move freeform messages between peers via a per-peer inbox
  (delivered at the recipient's next turn boundary). When --from / <peer-id>
  is omitted, the caller's identity is inferred by matching cwd to a peer's
  worktree path.

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
