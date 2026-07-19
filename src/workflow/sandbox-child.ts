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
  args?: Record<string, unknown> | null;
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

  // Monotonic per-agent-call index. Assigned in the deterministic order the
  // script issues ctx.agent() calls, so the same script + inputs map calls
  // 1:1 to their journal rows on resume (§14).
  let agentIndex = 0;

  const agent = (prompt: unknown, opts: unknown) => {
    const merged =
      opts && typeof opts === "object"
        ? { phase: currentPhase, ...(opts as Record<string, unknown>) }
        : currentPhase !== undefined
          ? { phase: currentPhase }
          : undefined;
    const index = agentIndex;
    agentIndex += 1;
    return bridgeCall("agent", [prompt, merged ?? null, index]);
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

  // verify: adversarial jury built on parallel()+agent(). N read-only jurors
  // each TRY TO REFUTE the claim (default to refuted when uncertain); the claim
  // survives unless a strict majority refutes it. Jurors can be engine-diverse
  // (rotate opts.engines) and perspective-diverse (rotate opts.lens). It's a
  // library helper over the primitives — no new bridge method.
  const VERDICT_SCHEMA = {
    type: "object",
    required: ["refuted", "reason"],
    properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  };
  const verify = async (claim: unknown, opts: unknown) => {
    const o = (opts && typeof opts === "object" ? (opts as Record<string, unknown>) : {}) as {
      jurors?: number;
      lens?: unknown;
      engines?: unknown;
      model?: string;
    };
    const jurorCount = Math.max(1, Math.floor(typeof o.jurors === "number" ? o.jurors : 3));
    const lenses = Array.isArray(o.lens) ? (o.lens as unknown[]).map(String) : undefined;
    const engines = Array.isArray(o.engines) ? (o.engines as unknown[]).map(String) : undefined;
    const claimText = typeof claim === "string" ? claim : String(claim);

    const tasks = Array.from({ length: jurorCount }, (_, i) => async () => {
      const lens = lenses && lenses.length ? lenses[i % lenses.length] : undefined;
      const engine = engines && engines.length ? engines[i % engines.length] : undefined;
      const prompt =
        `You are an adversarial reviewer. Try to REFUTE the following claim` +
        `${lens ? ` from the ${lens} perspective` : ""}:\n\n"${claimText}"\n\n` +
        `Investigate read-only. If the claim does not clearly hold, set refuted=true; ` +
        `default to refuted=true when uncertain. Output JSON only.`;
      const verdict = (await agent(prompt, {
        schema: VERDICT_SCHEMA,
        engine,
        model: o.model,
        label: `juror-${i + 1}${lens ? `:${lens}` : ""}`,
      })) as { refuted?: unknown; reason?: unknown };
      return { refuted: verdict?.refuted === true, reason: String(verdict?.reason ?? ""), lens: lens ?? null, engine: engine ?? "codex" };
    });

    // parallel() degrades a dead/erroring juror to null — a juror that couldn't
    // vote simply doesn't count toward the tally.
    const verdicts = (await parallel(tasks)).filter((v): v is { refuted: boolean; reason: string; lens: string | null; engine: string } => v != null);
    const refutedCount = verdicts.filter((v) => v.refuted).length;
    const survived = refutedCount * 2 <= verdicts.length; // strict-majority refute kills; ties survive
    return { claim: claimText, survived, refutedCount, jurors: verdicts.length, verdicts };
  };

  const ctx = Object.freeze({
    agent,
    parallel,
    pipeline,
    phase: (title: unknown) => {
      currentPhase = title === undefined || title === null ? undefined : String(title);
    },
    verify,
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
  // Slice D: the run's --args-json payload, frozen so the script can't mutate
  // shared state; undefined when the run was launched without args.
  sandbox.args = init.args == null ? undefined : Object.freeze(init.args);
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
