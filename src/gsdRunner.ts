// src/gsdRunner.ts
//
// GSD peer runner (Phase 33). Per-phase loop:
//   1. (frozen mode only) transition peer → gsd_running_gate_check, then
//      call gateFrozenPhase. On pass:false → write gate-failure artifact,
//      transition to gsd_halted_on_gate_failure, short-circuit batch.
//   2. transition peer → gsd_running_phase
//   3. spawn `codex exec --cwd <worktree> --json -- /gsd-autonomous --only <phaseId>`
//      (dynamic mode) or `/gsd-execute-phase <phaseId> --no-transition`
//      (frozen mode)
//   4. wait for codex to exit
//   5. transition peer → gsd_polling_state
//   6. read STATE.md via readStateDocument(repo)
//   7. if isPhaseComplete(state, phaseId): advance cursor + loop;
//      else: transition peer → gsd_failed with "phase did not advance"
//   8. when cursor exhausts selected_phases: transition peer → gsd_completed
//
// Plan 33-02 shipped the dynamic-mode path. Plan 33-03 adds gateFrozenPhase
// integration + gsd_running_gate_check + gsd_halted_on_gate_failure
// transitions for frozen mode.

import { spawn } from "node:child_process";
import { reasoningEffortArgs } from "./runner.js";
import type { GsdBatchSpawnConfig, PeerRecord } from "./types.js";
import {
  GsdStateMalformedError,
  GsdStateMissingError,
  isPhaseComplete,
  readStateDocument,
} from "./gsdState.js";
import {
  gateFrozenPhase,
  FrozenContractMalformedError,
  UnknownExtractorError,
} from "./frozen-gate/index.js";
import {
  buildGateFailureArtifact,
  writeGateFailureArtifact,
} from "./gsdGateFailure.js";

export type GsdRunnerDeps = {
  /**
   * Update a peer record (status + lastEvent + cursor advances). Implemented
   * by peerManager; injected here for testability with a fake.
   */
  updatePeer: (id: string, patch: Partial<PeerRecord>) => Promise<PeerRecord>;
  /**
   * Append a line to the peer's log file. Used for human-readable trace.
   */
  appendLog: (peer: PeerRecord, line: string) => Promise<void>;
};

export type CodexExecResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
};

export async function runGsdPhaseBatch(
  peer: PeerRecord,
  deps: GsdRunnerDeps,
  opts?: { codexBin?: string },
): Promise<PeerRecord> {
  const initialBatch: GsdBatchSpawnConfig | undefined = peer.gsdBatch;
  if (!initialBatch) {
    throw new Error(`runGsdPhaseBatch: peer ${peer.id} has no gsdBatch config`);
  }
  const planningMode = initialBatch.planning_mode;

  let current = peer;
  const selectedPhases = initialBatch.selected_phases;
  const startCursor = initialBatch.cursor;
  const codexBin = opts?.codexBin ?? "codex";

  for (let i = startCursor; i < selectedPhases.length; i++) {
    const phaseId = selectedPhases[i];
    // The runner is the only mutator of gsdBatch after dispatch; fall back to
    // the caller-supplied shape if a deps.updatePeer fake drops the field.
    const batch: GsdBatchSpawnConfig = current.gsdBatch ?? initialBatch;

    // --- Frozen-mode gate check (Phase 33-03 addition) ---
    if (planningMode === "frozen") {
      current = await deps.updatePeer(current.id, {
        status: "gsd_running_gate_check",
        lastEvent: `phase ${phaseId}: computing gateFrozenPhase`,
        gsdBatch: { ...batch, cursor: i },
        updatedAt: new Date().toISOString(),
      });
      let gateResult;
      try {
        gateResult = await gateFrozenPhase(current.repo, phaseId);
      } catch (err) {
        // Setup error — malformed contract or unknown extractor. These are
        // distinct from a mismatch: they mean the contract itself can't be
        // evaluated. Surface as gsd_failed, NOT gsd_halted_on_gate_failure.
        const reason =
          err instanceof FrozenContractMalformedError
            ? `frozen contract malformed: ${(err as Error).message}`
            : err instanceof UnknownExtractorError
              ? `unknown extractor: ${(err as Error).message}`
              : `gateFrozenPhase threw: ${(err as Error).message}`;
        current = await deps.updatePeer(current.id, {
          status: "gsd_failed",
          lastEvent: `phase ${phaseId}: ${reason}`,
          error: reason,
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return current;
      }
      if (!gateResult.pass) {
        // Halt: write the artifact, transition to gsd_halted_on_gate_failure,
        // do NOT invoke codex exec for this or any later phase.
        const artifact = buildGateFailureArtifact(gateResult, phaseId);
        const artifactPath = await writeGateFailureArtifact(
          current.repo,
          phaseId,
          artifact,
        );
        await deps.appendLog(
          current,
          `\n=== phase ${phaseId} (frozen): GATE FAILURE — halting batch ===\n`,
        );
        await deps.appendLog(
          current,
          `gate-failure artifact: ${artifactPath}\n`,
        );
        await deps.appendLog(
          current,
          `all_mismatches.length=${gateResult.all_mismatches.length}; first_mismatch=${JSON.stringify(gateResult.first_mismatch)}\n`,
        );
        current = await deps.updatePeer(current.id, {
          status: "gsd_halted_on_gate_failure",
          lastEvent: `phase ${phaseId}: gate FAIL (${gateResult.all_mismatches.length} mismatches) — artifact at ${artifactPath}`,
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return current;
      }
      await deps.appendLog(
        current,
        `phase ${phaseId} (frozen): gate PASS (${gateResult.checks.length} checks)\n`,
      );
    }

    // --- Phase invocation (shared by dynamic and frozen) ---
    current = await deps.updatePeer(current.id, {
      status: "gsd_running_phase",
      lastEvent:
        planningMode === "frozen"
          ? `phase ${phaseId}: invoking /gsd-execute-phase ${phaseId} --no-transition`
          : `phase ${phaseId}: invoking /gsd-autonomous --only ${phaseId} via codex exec`,
      gsdBatch: { ...batch, cursor: i },
      updatedAt: new Date().toISOString(),
    });
    await deps.appendLog(current, `\n=== phase ${phaseId} (${planningMode}) ===\n`);

    let result: CodexExecResult;
    try {
      result = await invokeCodexExec(
        current.repo,
        codexBin,
        phaseId,
        planningMode,
        current.model,
        current.reasoningEffort,
        async (chunk) => {
          await deps.appendLog(current, chunk);
        },
      );
    } catch (err) {
      const reason = (err as Error).message;
      current = await deps.updatePeer(current.id, {
        status: "gsd_failed",
        lastEvent: `phase ${phaseId}: codex exec spawn error: ${reason}`,
        error: reason,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return current;
    }

    if (result.exitCode !== 0) {
      current = await deps.updatePeer(current.id, {
        status: "gsd_failed",
        lastEvent: `phase ${phaseId}: codex exec exited with code ${result.exitCode} (signal=${result.signal})`,
        exitCode: result.exitCode,
        signal: result.signal,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return current;
    }

    // Step 4: transition to gsd_polling_state.
    current = await deps.updatePeer(current.id, {
      status: "gsd_polling_state",
      lastEvent: `phase ${phaseId}: codex exited 0; reading STATE.md`,
      updatedAt: new Date().toISOString(),
    });

    // Step 5: read STATE.md.
    let state;
    try {
      state = await readStateDocument(current.repo);
    } catch (err) {
      const reason =
        err instanceof GsdStateMissingError
          ? "STATE.md missing after codex exec"
          : err instanceof GsdStateMalformedError
            ? `STATE.md malformed: ${(err as Error).message}`
            : `STATE.md read error: ${(err as Error).message}`;
      current = await deps.updatePeer(current.id, {
        status: "gsd_failed",
        lastEvent: `phase ${phaseId}: ${reason}`,
        error: reason,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return current;
    }

    // Step 6: decide advance vs halt.
    if (!isPhaseComplete(state, phaseId)) {
      current = await deps.updatePeer(current.id, {
        status: "gsd_failed",
        lastEvent: `phase ${phaseId}: STATE.md did not show completion after codex exit (current_phase=${state.current_phase ?? state.phase ?? "?"}, complete=${state.complete})`,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return current;
    }
    await deps.appendLog(
      current,
      `phase ${phaseId}: STATE.md confirms completion; advancing cursor.\n`,
    );
  }

  // Step 7: cursor exhausted.
  const finalBatch: GsdBatchSpawnConfig = current.gsdBatch ?? initialBatch;
  current = await deps.updatePeer(current.id, {
    status: "gsd_completed",
    lastEvent: `all ${selectedPhases.length} phases completed`,
    gsdBatch: { ...finalBatch, cursor: selectedPhases.length },
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  return current;
}

/**
 * Spawn `codex exec` for a single phase. Streams stdout to onChunk so the
 * peer log captures the event stream. Returns exit code + signal.
 *
 * Dynamic mode: `codex exec --cwd <repo> [--model <m>] --json -- /gsd-autonomous --only <phaseId>`
 * Frozen mode: `... -- /gsd-execute-phase <phaseId> --no-transition`
 */
export async function invokeCodexExec(
  repo: string,
  codexBin: string,
  phaseId: string,
  mode: "dynamic" | "frozen",
  model: string | undefined,
  reasoningEffort: string | undefined,
  onChunk: (chunk: string) => Promise<void>,
): Promise<CodexExecResult> {
  const args = ["exec", "--cwd", repo, "--json"];
  if (model) args.push("--model", model);
  args.push("-c", "features.codex_hooks=false", ...reasoningEffortArgs(model, reasoningEffort));
  args.push("--");
  if (mode === "dynamic") {
    args.push("/gsd-autonomous", "--only", phaseId);
  } else {
    args.push("/gsd-execute-phase", phaseId, "--no-transition");
  }
  return await new Promise<CodexExecResult>((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b: Buffer) => {
      void onChunk(b.toString("utf8"));
    });
    child.stderr?.on("data", (b: Buffer) => {
      void onChunk(`[stderr] ${b.toString("utf8")}`);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 1, signal });
    });
  });
}
