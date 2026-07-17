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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecuteScriptRequest, ScriptExecution } from "./engine.js";

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
};

/**
 * Read + AST-validate the script, spawn the sandbox child, bridge its ctx
 * calls, and expose the run as a killable ScriptExecution handle.
 */
export function executeWorkflowScript(request: SandboxExecuteRequest): ScriptExecution {
  const scriptPath = resolve(request.scriptPath);
  const source = readFileSync(scriptPath, "utf8");
  validateWorkflowSource(source, scriptPath);

  const childPath = request.childPath ?? join(dirname(fileURLToPath(import.meta.url)), "sandbox-child.js");
  const child = spawn(process.execPath, ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", childPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
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
        void request
          .onCall(message.method, message.args ?? [])
          .then((value) => {
            if (child.connected) child.send({ type: "result", id: message.id, result: value ?? null });
          })
          .catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            if (child.connected) child.send({ type: "error", id: message.id, error: text });
          });
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
    });
  });

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
