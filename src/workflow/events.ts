// src/workflow/events.ts
//
// SP1 wave 4 — the workflow event stream (design §11). One producer, many
// subscribers; no view re-derives state. Dual transport:
//   - the durable/replayable SQLite `events` table (store.appendWorkflowEvent),
//     which the polled dashboard and `workflow_events` MCP tool read;
//   - a tailable ~/.delamain/events.jsonl for external subscribers (SP3/SP4),
//     following the peerIntegration.audit append-jsonl precedent.
//
// TODO(sp3/sp4): a Unix-domain-socket transport at ~/.delamain/events.sock for
// push subscribers; the SQLite table + jsonl are the substrate it will fan out.

import { appendFileSync } from "node:fs";
import { appendWorkflowEvent } from "../store.js";
import { eventsJsonlPath } from "../paths.js";

export type WorkflowEventType =
  | "workflow_start"
  | "phase_start"
  | "agent_spawn"
  | "agent_progress"
  | "agent_done"
  | "agent_failed"
  | "phase_done"
  | "workflow_end";

export type EmitEvent = (workflowId: string, type: WorkflowEventType, payload: Record<string, unknown>) => void;

/**
 * Emit one event to both transports. Best-effort and never throws into the
 * engine — a logging/telemetry failure must not fail a workflow.
 */
export function emitWorkflowEvent(workflowId: string, type: WorkflowEventType, payload: Record<string, unknown>): void {
  let seq = 0;
  let ts = new Date().toISOString();
  try {
    const row = appendWorkflowEvent(workflowId, type, payload);
    seq = row.seq;
    ts = row.ts;
  } catch {
    /* durable write failed; still try the tail file below */
  }
  try {
    appendFileSync(eventsJsonlPath(), `${JSON.stringify({ workflowId, seq, ts, type, ...payload })}\n`, "utf8");
  } catch {
    /* tail-file append best-effort */
  }
}
