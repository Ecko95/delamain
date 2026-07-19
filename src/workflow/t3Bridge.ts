// src/workflow/t3Bridge.ts
//
// SP3 Layer-0 — mirror delamain workflows into T3 (gitscode) as orchestration
// threads so the flow renders in T3's existing thread UI (agent_* events light
// up SubagentTaskSurface with zero web-UI work). Tails ~/.delamain/events.jsonl,
// maps each event to a T3 command, and POSTs to the additive ingress route
// POST /api/delamain/ingest (actor "server"). Wire shapes verified against
// gitscode's orchestrationEngine integration test.
//
// Best-effort and OPT-IN: disabled unless T3_BASE_URL/T3_TOKEN/T3_PROJECT_ID
// are set; a T3 outage never affects a workflow.
//
// Layer-1 observability: dispatch is edge-triggered — it logs only on ok<->fail
// transitions (via DispatchState threaded from the bridge run), so a dead T3 or
// expired token logs once, not once per event. Return values are unchanged.

import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { eventsJsonlPath } from "../paths.js";

export type T3BridgeConfig = {
  baseUrl: string;
  token: string;
  projectId: string;
  fetchImpl?: typeof fetch;
  // ponytail: display-container thread never runs a provider turn (we never
  // send thread.turn.start), so this is metadata only.
  instanceId?: string;
};

type T3Command = Record<string, unknown> & { type: string };

/** Env config, or null when the bridge is disabled. */
export function t3BridgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): T3BridgeConfig | null {
  const { T3_BASE_URL, T3_TOKEN, T3_PROJECT_ID } = env;
  if (!T3_BASE_URL || !T3_TOKEN || !T3_PROJECT_ID) return null;
  return { baseUrl: T3_BASE_URL.replace(/\/$/, ""), token: T3_TOKEN, projectId: T3_PROJECT_ID };
}

const threadIdFor = (workflowId: string) => `thread-${workflowId}`;

/**
 * Map one parsed jsonl event to the T3 command(s) to dispatch. Pure — this is
 * the testable core. workflow_start also births the thread.
 */
export function mapEventToCommands(ev: Record<string, unknown>, cfg: T3BridgeConfig): T3Command[] {
  const workflowId = String(ev.workflowId ?? "");
  const seq = Number(ev.seq ?? 0);
  const type = String(ev.type ?? "");
  const now = String(ev.ts ?? new Date().toISOString());
  const threadId = threadIdFor(workflowId);
  const cmdId = `cmd-${workflowId}-${seq}`; // deterministic → idempotent per (workflowId,seq)

  const activity = (kind: string, tone: string, summary: string, payload: Record<string, unknown> = {}): T3Command => ({
    type: "thread.activity.append",
    commandId: cmdId,
    threadId,
    activity: { id: `evt-${workflowId}-${seq}`, tone, kind, summary, payload, turnId: null, createdAt: now },
    createdAt: now,
  });

  switch (type) {
    case "workflow_start":
      return [
        {
          type: "thread.create",
          commandId: cmdId,
          threadId,
          projectId: cfg.projectId,
          title: String(ev.name ?? "delamain workflow"),
          modelSelection: { instanceId: cfg.instanceId ?? "delamain", model: "workflow" },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        // Distinct-but-deterministic commandId: thread.create already claims
        // cmd-<wf>-1, and T3 dedupes by commandId, so the companion activity
        // needs its own stable id or it gets dropped on ingest.
        { ...activity("info", "info", `workflow started: ${String(ev.name ?? "")}`, { scriptPath: ev.scriptPath }), commandId: `${cmdId}-started` },
      ];
    case "phase_start":
      return [activity("phase", "info", `phase ${String(ev.phase ?? "")}`)];
    case "agent_spawn":
      return [
        activity("task.started", "tool", `${String(ev.engine ?? "")}/${String(ev.model ?? "")}`, {
          taskType: "subagent",
          taskId: ev.node,
          description: `${String(ev.engine ?? "")}/${String(ev.model ?? "")}`,
          phase: ev.phase,
        }),
      ];
    case "agent_done":
      return [
        activity("task.completed", "info", `agent ${String(ev.node ?? "")} done`, {
          taskId: ev.node,
          status: "completed",
          elapsedMs: ev.elapsedMs,
          tokensSpent: ev.tokensSpent,
        }),
      ];
    case "agent_failed":
      return [
        activity("task.completed", "error", `agent ${String(ev.node ?? "")} failed`, {
          taskId: ev.node,
          status: "failed",
          err: ev.err,
        }),
      ];
    case "phase_done":
      return [activity("phase", "info", `phase ${String(ev.phase ?? "")} done`)];
    case "workflow_end":
      return [
        activity(
          "info",
          ev.status === "done" ? "info" : "error",
          `workflow ${String(ev.status ?? "")}`,
          { status: ev.status, elapsedMs: ev.elapsedMs, totalAgents: ev.totalAgents, tokensSpent: ev.tokensSpent },
        ),
      ];
    // agent_progress is declared but emitted nowhere in delamain; skip. Unknown
    // types (e.g. a GSD-batch phase_retry) also skip — no T3 counterpart.
    default:
      return [];
  }
}

/** Last dispatch outcome, so we only log on ok<->fail transitions. */
export type DispatchState = { lastOk: boolean };
export const newDispatchState = (): DispatchState => ({ lastOk: true });

/** POST one command to the T3 ingress. Best-effort; resolves false on failure. */
async function dispatch(cfg: T3BridgeConfig, cmd: T3Command, state: DispatchState): Promise<boolean> {
  const f = cfg.fetchImpl ?? fetch;
  let ok = false;
  let reason = "";
  try {
    const res = await f(`${cfg.baseUrl}/api/delamain/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(cmd),
    });
    ok = res.ok;
    if (!ok) reason = `HTTP ${res.status}`;
  } catch (err: any) {
    // network failure: prefer a code (ECONNREFUSED, etc.) then message.
    reason = String(err?.code ?? err?.message ?? err);
  }
  // Edge-triggered: one line per transition, never the token or full config.
  if (ok !== state.lastOk) {
    if (ok) console.error(`[t3Bridge] dispatch recovered: ${cmd.type} ${String(cmd.commandId)}`);
    else console.error(`[t3Bridge] dispatch failed: ${cmd.type} ${String(cmd.commandId)} — ${reason}`);
  }
  state.lastOk = ok;
  return ok;
}

/** Map + dispatch every command for one jsonl line. Returns commands attempted. */
export async function ingestLine(cfg: T3BridgeConfig, line: string, state: DispatchState = newDispatchState()): Promise<T3Command[]> {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const cmds = mapEventToCommands(ev, cfg);
  for (const cmd of cmds) await dispatch(cfg, cmd, state);
  return cmds;
}

/**
 * Tail ~/.delamain/events.jsonl and forward to T3 until aborted.
 * ponytail: naive line-count cursor + full re-read per poll; add a byte offset
 * and log rotation when events.jsonl grows large or the bridge must survive
 * restarts mid-workflow.
 */
export async function startT3Bridge(cfg: T3BridgeConfig, opts: { pollMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const path = eventsJsonlPath();
  const pollMs = opts.pollMs ?? 1000;
  let processed = 0;
  const state = newDispatchState(); // per-run, so a second startT3Bridge is independent
  while (!opts.signal?.aborted) {
    try {
      if (statSync(path, { throwIfNoEntry: false })) {
        const lines = readFileSync(path, "utf8").split("\n");
        // last element is a trailing "" from the final newline; ignore it.
        const complete = lines.slice(0, -1);
        for (let i = processed; i < complete.length; i += 1) await ingestLine(cfg, complete[i], state);
        processed = complete.length;
      }
    } catch {
      /* transient read error; retry next poll */
    }
    await delay(pollMs);
  }
}
