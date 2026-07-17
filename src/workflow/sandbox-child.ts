// src/workflow/sandbox-child.ts
//
// SP1 wave 1 — the entry that runs INSIDE the sandbox child process (spawned
// by sandbox.ts with --experimental-vm-modules and an IPC channel).
//
// It builds a node:vm context from an empty global — the script sees only:
//   ctx (agent/log, proxied to the parent over IPC), console (→ ctx.log),
//   deterministic Math.random (seeded PRNG) and Date (fixed epoch) shims,
// plus the plain ECMAScript intrinsics of the fresh realm. No require, no
// process, no fetch, no timers. Every ctx call serializes
// {id, method, args} to the parent and resolves the pending promise when the
// matching {id, result|error} reply arrives (the async ctx bridge).

import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

type InitMessage = {
  type: "init";
  source: string;
  filename: string;
  seed: number;
  startTimeMs: number;
  budgetTotal: number | null;
};

type ParentReply =
  | { type: "result"; id: number; result: unknown; budgetSpent?: number }
  | { type: "error"; id: number; error: string; budgetSpent?: number };

// Eventually-consistent mirror of the parent's budget accounting. The parent
// stamps the current spend on every reply; the script reads it via ctx.budget.
let budgetSpent = 0;

function send(message: unknown): void {
  process.send?.(message);
}

function fail(error: unknown): void {
  const text = error instanceof Error ? `${error.message}` : String(error);
  send({ type: "failed", error: text });
  // Give the IPC channel a tick to flush, then exit.
  setTimeout(() => process.exit(1), 20);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

let initialized = false;
let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function bridgeCall(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCallId;
    nextCallId += 1;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, method, args });
  });
}

process.on("message", (raw: unknown) => {
  const message = raw as InitMessage | ParentReply;
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    if (!initialized) {
      initialized = true;
      void runWorkflow(message).catch(fail);
    }
    return;
  }
  if (typeof message.budgetSpent === "number") {
    budgetSpent = message.budgetSpent;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.type === "result") {
    entry.resolve(message.result);
  } else if (message.type === "error") {
    entry.reject(new Error(message.error));
  }
});

async function runWorkflow(init: InitMessage): Promise<void> {
  // Current progress-group label. Captured per agent() call (best-effort;
  // concurrent phases race, which is acknowledged in the design).
  let currentPhase: string | undefined;

  const total = init.budgetTotal;
  const budget = Object.freeze({
    total,
    spent: () => budgetSpent,
    remaining: () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - budgetSpent)),
  });

  const agent = (prompt: unknown, opts: unknown) => {
    const merged =
      opts && typeof opts === "object"
        ? { phase: currentPhase, ...(opts as Record<string, unknown>) }
        : currentPhase !== undefined
          ? { phase: currentPhase }
          : undefined;
    return bridgeCall("agent", merged === undefined ? [prompt] : [prompt, merged]);
  };

  // parallel: barrier fan-out; a throwing thunk resolves to null.
  const parallel = (thunks: unknown) => {
    if (!Array.isArray(thunks)) {
      return Promise.reject(new TypeError("ctx.parallel(thunks) requires an array of functions"));
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        if (typeof thunk !== "function") return null;
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  };

  // pipeline: no-barrier streaming; each item runs its own stage chain. A
  // stage throw drops that item to null and skips its remaining stages.
  const pipeline = (items: unknown, ...stages: unknown[]) => {
    if (!Array.isArray(items)) {
      return Promise.reject(new TypeError("ctx.pipeline(items, ...stages) requires an array of items"));
    }
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          if (typeof stage !== "function") continue;
          try {
            acc = await (stage as (p: unknown, it: unknown, i: number) => unknown)(acc, item, index);
          } catch {
            return null;
          }
        }
        return acc;
      }),
    );
  };

  const ctx = Object.freeze({
    agent,
    parallel,
    pipeline,
    phase: (title: unknown) => {
      currentPhase = title === undefined || title === null ? undefined : String(title);
    },
    log: (message: unknown) => {
      void bridgeCall("log", [typeof message === "string" ? message : String(message)]);
    },
    budget,
  });
  const consoleShim = Object.freeze({
    log: (...args: unknown[]) => ctx.log(args.map(String).join(" ")),
    info: (...args: unknown[]) => ctx.log(args.map(String).join(" ")),
    warn: (...args: unknown[]) => ctx.log(`WARN ${args.map(String).join(" ")}`),
    error: (...args: unknown[]) => ctx.log(`ERROR ${args.map(String).join(" ")}`),
  });

  // The context global is built from an empty prototype: only ctx + console
  // are injected. The fresh realm brings its own ECMAScript intrinsics; the
  // bootstrap below overrides its Math.random/Date with deterministic shims.
  const sandbox: Record<string, unknown> = Object.create(null);
  sandbox.ctx = ctx;
  sandbox.console = consoleShim;
  const context = vm.createContext(sandbox);

  vm.runInContext(
    `(function bootstrapDeterminism(start, seed) {
      "use strict";
      let state = seed >>> 0;
      Math.random = function random() {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const RealDate = Date;
      class FixedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) {
            super(start);
          } else {
            super(...args);
          }
        }
        static now() {
          return start;
        }
      }
      globalThis.Date = FixedDate;
    })(${JSON.stringify(init.startTimeMs)}, ${JSON.stringify(init.seed)});`,
    context,
    { filename: "delamain-sandbox-bootstrap.js" },
  );

  let js: string;
  try {
    js = stripTypeScriptTypes(init.source);
  } catch (error) {
    throw new Error(
      `could not strip TypeScript types from ${init.filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rejectImport = (specifier: string): never => {
    throw new Error(`workflow scripts cannot import modules (tried to import '${specifier}')`);
  };
  const mod = new vm.SourceTextModule(js, {
    context,
    identifier: init.filename,
    importModuleDynamically: (specifier: string) => rejectImport(specifier),
  });
  await mod.link((specifier: string) => rejectImport(specifier));
  await mod.evaluate();

  const namespace = mod.namespace as { meta?: unknown; default?: unknown };
  const meta = namespace.meta as { name?: unknown } | undefined;
  if (!meta || typeof meta !== "object" || typeof meta.name !== "string" || !meta.name) {
    throw new Error("workflow script must `export const meta = { name, description }` with a non-empty name");
  }
  const run = namespace.default;
  if (typeof run !== "function") {
    throw new Error("workflow script must `export default async function run(ctx)`");
  }

  const result = await (run as (c: typeof ctx) => Promise<unknown>)(ctx);

  let jsonSafe: unknown = null;
  if (result !== undefined) {
    try {
      jsonSafe = JSON.parse(JSON.stringify(result));
    } catch {
      throw new Error("workflow return value is not JSON-serializable");
    }
  }
  send({ type: "done", result: jsonSafe });
  setTimeout(() => process.exit(0), 20);
}
