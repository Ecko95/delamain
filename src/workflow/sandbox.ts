// src/workflow/sandbox.ts
//
// SP1 wave 1 — host side of the workflow-script sandbox (§7 of the design
// spec). Executes the script in a CHILD PROCESS whose node:vm context is
// built from empty (sandbox-child.ts); every capability call round-trips the
// async ctx bridge: child sends {type:"call", id, method, args} over IPC, the
// parent runs the real peer machinery and replies {type:"result"|"error", id}.
//
// node:vm is NOT the security boundary — it only controls the language-level
// global (no require/process/fetch/setTimeout in the context). Defence in
// depth here is the tree-sitter AST gate below. The real OS jail is
// deliberately minimal this wave:
//   TODO(sp1-wave2): seccomp/landlock syscall filter for the child
//   TODO(sp1-wave2): network namespace (deny-all) around the child
//   TODO(sp1-wave2): cgroup v2 slice (memory.max / cpu.max / pids.max)
// The ctx interface is frozen so those layers harden later without API change.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecuteScriptRequest, ScriptExecution } from "./engine.js";
import { buildJailPlan } from "./jail.js";

const require = createRequire(import.meta.url);

export class WorkflowSourceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSourceRejectedError";
  }
}

/**
 * Defence-in-depth AST gate: reject workflow sources that mention
 * require / process / eval or import anything (static or dynamic) before the
 * script ever reaches the child. Uses the repo's existing tree-sitter deps.
 */
export function validateWorkflowSource(source: string, filename = "workflow.ts"): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Parser: any = require("tree-sitter");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { typescript: typescriptLanguage }: any = require("tree-sitter-typescript");
  const parser = new Parser();
  parser.setLanguage(typescriptLanguage);
  const tree = parser.parse(source);

  const violations: string[] = [];
  const BANNED_IDENTIFIERS = new Set(["require", "process", "eval"]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any): void => {
    if (node.type === "import_statement") {
      violations.push(`import statement at line ${node.startPosition.row + 1}`);
    } else if (node.type === "call_expression" && node.firstChild?.type === "import") {
      violations.push(`dynamic import() at line ${node.startPosition.row + 1}`);
    } else if (node.type === "identifier" && BANNED_IDENTIFIERS.has(node.text)) {
      violations.push(`'${node.text}' at line ${node.startPosition.row + 1}`);
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      visit(node.namedChild(i));
    }
  };
  visit(tree.rootNode);

  if (violations.length > 0) {
    throw new WorkflowSourceRejectedError(
      `workflow script ${filename} rejected: workflow scripts may only interact with the world via ctx — found ${violations.join(", ")}`,
    );
  }
}

type ChildMessage =
  | { type: "call"; id: number; method: string; args: unknown[] }
  | { type: "done"; result: unknown }
  | { type: "failed"; error: string };

export type SandboxExecuteRequest = ExecuteScriptRequest & {
  /** Override the child entry (tests). Defaults to ./sandbox-child.js. */
  childPath?: string;
  /** Loud degraded-mode + jail-status notices for the run log. */
  onWarning?: (message: string) => void;
};

let scratchCounter = 0;

/**
 * Read + AST-validate the script, spawn the sandbox child (wrapped in the OS
 * jail when available), bridge its ctx calls, and expose the run as a killable
 * ScriptExecution handle.
 */
export function executeWorkflowScript(request: SandboxExecuteRequest): ScriptExecution {
  const scriptPath = resolve(request.scriptPath);
  const source = readFileSync(scriptPath, "utf8");
  validateWorkflowSource(source, scriptPath);

  const warn = request.onWarning ?? (() => {});
  const childPath = request.childPath ?? join(dirname(fileURLToPath(import.meta.url)), "sandbox-child.js");
  const nodeArgs = ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", childPath];

  // Per-run scratch dir: the only writable path Landlock grants the child.
  scratchCounter += 1;
  const scratchDir = join(tmpdir(), `delamain-wf-scratch-${process.pid}-${scratchCounter}`);
  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch {
    /* fall back to tmp root */
  }

  // OS jail (spec §7): the real deny-fs/shell/net boundary. node:vm alone is
  // not a security boundary — if the jail can't engage on this host, we run
  // unjailed and say so loudly (trusted scripts only).
  const noJail = process.env.DELAMAIN_SANDBOX_NO_JAIL === "1";
  const plan = noJail ? { available: false, reason: "DELAMAIN_SANDBOX_NO_JAIL=1", prefixArgs: [], env: {} } : buildJailPlan({ childPath, scratchDir });

  let command: string;
  let commandArgs: string[];
  let spawnEnv: NodeJS.ProcessEnv = process.env;
  if (plan.available && plan.command) {
    command = plan.command;
    commandArgs = [...plan.prefixArgs, process.execPath, ...nodeArgs];
    spawnEnv = { ...process.env, ...plan.env };
  } else {
    warn(`SANDBOX DEGRADED: OS jail inactive — trusted scripts only (${plan.reason ?? "unavailable"})`);
    command = process.execPath;
    commandArgs = nodeArgs;
  }

  const child = spawn(command, commandArgs, {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: spawnEnv,
  });

  let stderrTail = "";
  let stderrLineBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    // Forward the jail's own per-layer degraded warnings to the run log.
    stderrLineBuf += chunk;
    let idx = stderrLineBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stderrLineBuf.slice(0, idx);
      stderrLineBuf = stderrLineBuf.slice(idx + 1);
      if (line.includes("SANDBOX DEGRADED")) warn(line.trim());
      idx = stderrLineBuf.indexOf("\n");
    }
  });

  let settled = false;
  let killed: string | undefined;

  const result = new Promise<unknown>((resolvePromise, rejectPromise) => {
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    child.on("message", (raw: unknown) => {
      const message = raw as ChildMessage;
      if (!message || typeof message !== "object") return;
      if (message.type === "call") {
        // Reply exactly once. The budget is read HERE (after onCall settled, so
        // it reflects this call's spend), guarded so a throw can't leave the
        // child's bridge call hanging forever.
        const reply = (payload: Record<string, unknown>) => {
          let budgetSpent = 0;
          try {
            budgetSpent = request.getBudgetSpent();
          } catch {
            /* stamp 0 rather than drop the reply */
          }
          if (child.connected) child.send({ ...payload, id: message.id, budgetSpent });
        };
        void request
          .onCall(message.method, message.args ?? [])
          .then((value) => reply({ type: "result", result: value ?? null }))
          .catch((error: unknown) => reply({ type: "error", error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (message.type === "done") {
        settle(() => resolvePromise(message.result));
        return;
      }
      if (message.type === "failed") {
        settle(() => rejectPromise(new Error(message.error)));
      }
    });

    child.on("error", (error) => {
      settle(() => rejectPromise(new Error(`sandbox child failed to start: ${error.message}`)));
    });

    child.on("exit", (code, signal) => {
      settle(() =>
        rejectPromise(
          new Error(
            killed
              ? `sandbox child killed (${killed})`
              : `sandbox child exited unexpectedly (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
          ),
        ),
      );
    });

    child.send({
      type: "init",
      source,
      filename: scriptPath,
      seed: request.seed,
      startTimeMs: request.startTimeMs,
      budgetTotal: request.budgetTotal,
    });
  });

  const cleanupScratch = () => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  child.on("exit", cleanupScratch);

  return {
    result,
    kill: (reason = "killed") => {
      if (killed === undefined && child.exitCode === null && !child.killed) {
        killed = reason;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}
