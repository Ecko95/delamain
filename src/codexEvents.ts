const THREAD_ID_KEYS = new Set([
  "threadid",
  "thread_id",
  "conversationid",
  "conversation_id",
  "sessionid",
  "session_id",
]);

const TEXT_KEYS = new Set([
  "content",
  "delta",
  "message",
  "text",
  "summary",
  "output",
  "final_output",
]);

export type ParsedCodexEvent = {
  threadId?: string;
  text?: string;
  label?: string;
  waitingQuestion?: string;
};

export function parseCodexJsonLine(line: string): ParsedCodexEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseText(line);
  }

  const threadId = findThreadId(parsed);
  const texts = collectText(parsed);
  const text = texts.join(" ").replace(/\s+/g, " ").trim() || undefined;
  const label = eventLabel(parsed, text);
  const waitingQuestion = parseWaitingQuestion(`${line}\n${text || ""}`);

  return { threadId, text, label, waitingQuestion };
}

function parseText(text: string): ParsedCodexEvent {
  return {
    text,
    label: trim(text, 180),
    waitingQuestion: parseWaitingQuestion(text),
  };
}

function findThreadId(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findThreadId(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (THREAD_ID_KEYS.has(key.toLowerCase()) && typeof child === "string" && child.length > 0) {
      return child;
    }
    const found = findThreadId(child, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 7 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const texts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (TEXT_KEYS.has(key.toLowerCase()) && typeof child === "string") {
      const trimmed = child.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    } else {
      texts.push(...collectText(child, depth + 1));
    }
  }
  return texts;
}

function eventLabel(value: unknown, fallback?: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const msg = fallback ? trim(fallback, 140) : undefined;
    return [type, msg].filter(Boolean).join(": ") || trim(JSON.stringify(value), 180);
  }
  return fallback ? trim(fallback, 180) : "";
}

export function parseWaitingQuestion(text: string): string | undefined {
  if (!/CODEX_PEERS_STATUS\s*:\s*WAITING/i.test(text)) {
    return undefined;
  }
  const question = text.match(/QUESTION\s*:\s*([\s\S]+)/i)?.[1]?.trim();
  return question ? trim(question, 1000) : "Peer reported that it is waiting for orchestrator input.";
}

export function trim(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, max - 1))}…`;
}
