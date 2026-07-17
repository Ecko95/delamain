// src/workflow/schema.ts
//
// SP1 wave 1 — structured agent output (§6 of the design spec). The peer is
// instructed to emit one fenced JSON object AND write it to
// .delamain/result.json in its worktree (belt-and-suspenders). On terminal
// done we prefer the file, fall back to parsing the final message, then
// validate against the caller's JSON Schema with Ajv. Mismatches are retried
// via resumePeer (bounded, driven by ctx.ts).

import { Ajv, type ValidateFunction } from "ajv";

/** Retries after the first attempt (3 validation attempts total). */
export const SCHEMA_MAX_RETRIES = 2;

export type SchemaValidation = { valid: boolean; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): SchemaValidation {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(value)) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map((err) => {
    const path = err.instancePath || "(root)";
    return `${path} ${err.message ?? "invalid"}${err.params ? ` ${JSON.stringify(err.params)}` : ""}`;
  });
  return { valid: false, errors: errors.length > 0 ? errors : ["value does not match schema"] };
}

/** Instruction block appended to the task prompt when opts.schema is set. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `
STRUCTURED OUTPUT REQUIRED:
- Your FINAL message must contain exactly one fenced JSON code block (\`\`\`json ... \`\`\`) holding a single JSON object that validates against this JSON Schema:
${JSON.stringify(schema, null, 2)}
- ALSO write that exact JSON object to the file .delamain/result.json at the repository root (create the .delamain directory if needed).
- Output JSON only inside the fenced block — no comments or prose.`;
}

/** Resume prompt sent to the peer after a validation mismatch. */
export function schemaRetryPrompt(errors: string[], schema: Record<string, unknown>): string {
  return `Your structured output failed validation against the required JSON Schema.

Validation errors:
${errors.map((line) => `- ${line}`).join("\n")}

Required JSON Schema:
${JSON.stringify(schema, null, 2)}

Reply with a corrected single fenced JSON code block (\`\`\`json ... \`\`\`) containing one JSON object that validates, and overwrite .delamain/result.json with that corrected object.`;
}

export type ExtractedResult =
  | { ok: true; value: unknown; source: "file" | "message" }
  | { ok: false; error: string };

/**
 * Extract the structured result: prefer the .delamain/result.json contents
 * (passed in pre-read so this stays pure), else the LAST fenced JSON block in
 * the final message, else the whole trimmed message as JSON.
 */
export function extractAgentResult(input: {
  resultFileContent?: string;
  finalResult?: string;
}): ExtractedResult {
  if (input.resultFileContent !== undefined) {
    try {
      return { ok: true, value: JSON.parse(input.resultFileContent), source: "file" };
    } catch {
      // fall through to the message
    }
  }
  const message = input.finalResult ?? "";
  const fenced = [...message.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    try {
      return { ok: true, value: JSON.parse(fenced[i][1]), source: "message" };
    } catch {
      // try an earlier block
    }
  }
  const trimmed = message.trim();
  if (trimmed) {
    try {
      return { ok: true, value: JSON.parse(trimmed), source: "message" };
    } catch {
      // no parseable JSON anywhere
    }
  }
  return { ok: false, error: "no parseable JSON object found in .delamain/result.json or the final message" };
}
