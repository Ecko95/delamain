import { existsSync, openSync, closeSync, fstatSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexContextLevel = "green" | "yellow" | "red" | "skull";

export type CodexContext = {
  inputTokens: number;
  contextWindow: number;
  usedPercent: number;
  level: CodexContextLevel;
  compacted: boolean;
  source?: string;
};

// token_count events sit near the end of the JSONL and recur every turn, so a
// small tail covers the last several. 512 KiB is plenty for the last two.
const DEFAULT_TAIL_BYTES = 512 * 1024;

// Fallback ONLY. Codex reports the real window as info.model_context_window on
// every token_count event (observed 258400 for gpt-5-class), so the live value
// wins and this rarely bites. Operator-tunable via env.
// ponytail: unverified constant; upgrade path is env override, not a per-model table.
const FALLBACK_CONTEXT_WINDOW = Number(
  process.env.DELAMAIN_CODEX_CONTEXT_WINDOW || process.env.GITS_CODEX_CONTEXT_WINDOW || 272000,
);

// Compaction = codex summarizing history away, which drops current-turn
// input_tokens sharply. Flag a drop below RATIO of the prior reading, provided
// the prior reading was already substantial (avoids noise early in a session).
// ponytail: fixed heuristic; env-tunable if it misfires, no learned model.
const COMPACTION_DROP_RATIO = Number(process.env.DELAMAIN_CODEX_COMPACTION_DROP_RATIO || 0.6);
const COMPACTION_MIN_PRIOR_TOKENS = Number(process.env.DELAMAIN_CODEX_COMPACTION_MIN_PRIOR || 20000);

const LEVEL_RANK: Record<CodexContextLevel, number> = { green: 0, yellow: 1, red: 2, skull: 3 };

type RawInfo = {
  last_token_usage?: { input_tokens?: unknown } | null;
  model_context_window?: unknown;
};

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function contextLevel(usedPercent: number): CodexContextLevel {
  if (usedPercent >= 95) {
    return "skull";
  }
  if (usedPercent >= 85) {
    return "red";
  }
  if (usedPercent >= 70) {
    return "yellow";
  }
  return "green";
}

/**
 * Read a peer's current context occupancy from its codex session JSONL.
 *
 * Peer→session mapping (verified): peer.threadId is the codex `thread.started`
 * id, which equals session_meta.session_id, which is the trailing UUID of the
 * rollout filename `rollout-<ts>-<UUID>.jsonl`. So we locate the file by name
 * suffix `-<threadId>.jsonl` (most recent mtime if a resume produced several).
 */
export function readPeerContext(
  threadId: string | undefined,
  options: { home?: string; maxBytes?: number } = {},
): CodexContext | undefined {
  if (!threadId) {
    return undefined;
  }
  const home = options.home || codexHome();
  const file = findSessionFile(join(home, "sessions"), threadId);
  if (!file) {
    return undefined;
  }
  const text = readTail(file, options.maxBytes ?? DEFAULT_TAIL_BYTES);
  return contextFromSession(text, file);
}

export function contextFromSession(text: string, source?: string): CodexContext | undefined {
  const usages: Array<{ input: number; window?: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("\"token_count\"")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { payload?: { info?: RawInfo } };
      const info = parsed.payload?.info;
      const input = numeric(info?.last_token_usage?.input_tokens);
      if (input === undefined) {
        continue;
      }
      usages.push({ input, window: numeric(info?.model_context_window) });
    } catch {
      // Tail chunks can begin mid-line; ignore partial JSONL records.
    }
  }
  if (usages.length === 0) {
    return undefined;
  }
  const latest = usages[usages.length - 1];
  const prior = usages[usages.length - 2];
  const contextWindow = latest.window ?? FALLBACK_CONTEXT_WINDOW;
  const usedPercent = clampPercent((latest.input / contextWindow) * 100);
  const compacted = Boolean(
    prior && prior.input >= COMPACTION_MIN_PRIOR_TOKENS && latest.input < prior.input * COMPACTION_DROP_RATIO,
  );
  return {
    inputTokens: latest.input,
    contextWindow,
    usedPercent,
    level: contextLevel(usedPercent),
    compacted,
    source,
  };
}

/**
 * Human-readable note when context crosses a worse threshold than last seen, or
 * when compaction is first detected. Returns undefined when nothing changed, so
 * the caller only overwrites lastEvent on genuine escalations (no 5s spam).
 */
export function contextTransitionNote(
  ctx: CodexContext,
  previousLevel: CodexContextLevel | undefined,
  compactionAlreadyNoticed: boolean,
): string | undefined {
  if (ctx.compacted && !compactionAlreadyNoticed) {
    return "codex auto-compacted — review output carefully";
  }
  const previousRank = previousLevel ? LEVEL_RANK[previousLevel] : 0;
  if (LEVEL_RANK[ctx.level] <= previousRank || ctx.level === "green") {
    return undefined;
  }
  if (ctx.level === "skull") {
    return `context ${ctx.usedPercent}% — critical, codex may auto-compact`;
  }
  if (ctx.level === "red") {
    return `context ${ctx.usedPercent}% — near limit, consider splitting`;
  }
  return `context ${ctx.usedPercent}% — approaching limit`;
}

function findSessionFile(root: string, threadId: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }
  const suffix = `-${threadId}.jsonl`;
  let best: { path: string; mtime: number } | undefined;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      continue;
    }
    for (const entry of safeReadDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) {
          best = { path, mtime };
        }
      }
    }
  }
  return best?.path;
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}
