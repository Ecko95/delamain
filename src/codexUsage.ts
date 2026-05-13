import { existsSync, openSync, closeSync, fstatSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexUsageLevel = "green" | "yellow" | "red" | "skull";

export type CodexUsageLimit = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes?: number;
  resetAt?: string;
  level: CodexUsageLevel;
};

export type CodexUsage = {
  planType?: string;
  limits: CodexUsageLimit[];
  source?: string;
};

type RawRateLimit = {
  used_percent?: unknown;
  window_minutes?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
};

type RawRateLimits = {
  primary?: RawRateLimit | null;
  secondary?: RawRateLimit | null;
  plan_type?: unknown;
};

type RawRateLimitsEvent = {
  type?: unknown;
  plan_type?: unknown;
  rate_limits?: RawRateLimits | null;
};

const DEFAULT_TAIL_BYTES = 12 * 1024 * 1024;

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function readCodexUsage(options: { home?: string; maxBytes?: number } = {}): CodexUsage | undefined {
  const home = options.home || codexHome();
  const sessionUsage = readSessionUsage(home, options.maxBytes ?? DEFAULT_TAIL_BYTES);
  if (sessionUsage) {
    return sessionUsage;
  }

  const files = [
    join(home, "log", "codex-tui.log"),
    join(home, "logs_2.sqlite"),
    join(home, "logs_2.sqlite-wal"),
  ]
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

  let latest: { event: RawRateLimitsEvent; source: string } | undefined;
  for (const file of files) {
    const text = readTail(file, options.maxBytes ?? DEFAULT_TAIL_BYTES);
    for (const event of extractRateLimitEvents(text)) {
      latest = { event, source: file };
    }
  }
  return latest ? usageFromRateLimitEvent(latest.event, latest.source) : undefined;
}

export function usageLevel(remainingPercent: number): CodexUsageLevel {
  if (remainingPercent < 20) {
    return "skull";
  }
  if (remainingPercent < 40) {
    return "red";
  }
  if (remainingPercent < 75) {
    return "yellow";
  }
  return "green";
}

export function usageFromRateLimitEvent(event: RawRateLimitsEvent, source?: string): CodexUsage | undefined {
  if (event.type !== "codex.rate_limits" || !event.rate_limits) {
    return undefined;
  }
  return usageFromRateLimits(event.rate_limits, typeof event.plan_type === "string" ? event.plan_type : undefined, source);
}

function usageFromRateLimits(rateLimits: RawRateLimits, planType?: string, source?: string): CodexUsage | undefined {
  const rawLimits = [rateLimits.primary, rateLimits.secondary];
  const limits = rawLimits
    .map((limit) => usageLimitFromRaw(limit || undefined))
    .filter((limit): limit is CodexUsageLimit => Boolean(limit));
  if (limits.length === 0) {
    return undefined;
  }
  return {
    planType: planType || (typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : undefined),
    limits: limits.sort((a, b) => (a.windowMinutes || 0) - (b.windowMinutes || 0)),
    source,
  };
}

function usageLimitFromRaw(raw: RawRateLimit | undefined): CodexUsageLimit | undefined {
  const usedPercent = numeric(raw?.used_percent);
  if (usedPercent === undefined) {
    return undefined;
  }
  const windowMinutes = numeric(raw?.window_minutes);
  const remainingPercent = clampPercent(100 - usedPercent);
  const resetAtSeconds = numeric(raw?.reset_at) ?? numeric(raw?.resets_at);
  return {
    label: usageLabel(windowMinutes),
    usedPercent: clampPercent(usedPercent),
    remainingPercent,
    windowMinutes,
    resetAt: resetAtSeconds === undefined ? undefined : new Date(resetAtSeconds * 1000).toISOString(),
    level: usageLevel(remainingPercent),
  };
}

function readSessionUsage(home: string, maxBytes: number): CodexUsage | undefined {
  const files = recentSessionFiles(join(home, "sessions"), 16);
  let latest: CodexUsage | undefined;
  for (const file of files) {
    const text = readTail(file, Math.min(maxBytes, 1024 * 1024));
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("\"rate_limits\"")) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { payload?: { rate_limits?: RawRateLimits } };
        if (parsed.payload?.rate_limits) {
          latest = usageFromRateLimits(parsed.payload.rate_limits, undefined, file) || latest;
        }
      } catch {
        // Tail chunks can begin mid-line; ignore partial JSONL records.
      }
    }
  }
  return latest;
}

function recentSessionFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
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
      } else if (entry.isFile() && path.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  return files
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .slice(-limit);
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function usageLabel(windowMinutes: number | undefined): string {
  if (windowMinutes === 300) {
    return "5h";
  }
  if (windowMinutes === 10080) {
    return "weekly";
  }
  if (windowMinutes && windowMinutes % 60 === 0 && windowMinutes < 10080) {
    return `${windowMinutes / 60}h`;
  }
  if (windowMinutes && windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }
  return "usage";
}

function extractRateLimitEvents(text: string): RawRateLimitsEvent[] {
  const events: RawRateLimitsEvent[] = [];
  const marker = "{\"type\":\"codex.rate_limits\"";
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(marker, offset);
    if (start === -1) {
      break;
    }
    const jsonText = extractJsonObject(text, start);
    offset = start + marker.length;
    if (!jsonText) {
      continue;
    }
    offset = start + jsonText.length;
    try {
      const parsed = JSON.parse(jsonText) as RawRateLimitsEvent;
      if (parsed.type === "codex.rate_limits") {
        events.push(parsed);
      }
    } catch {
      // Ignore partial SQLite/log fragments.
    }
  }
  return events;
}

function extractJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
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
