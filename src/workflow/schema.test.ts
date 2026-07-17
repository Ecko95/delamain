import { describe, expect, it } from "vitest";
import { extractAgentResult, schemaInstruction, schemaRetryPrompt, validateAgainstSchema } from "./schema.js";

const RISK_SCHEMA = {
  type: "object",
  required: ["risk", "severity"],
  properties: {
    risk: { type: "string" },
    severity: { enum: ["low", "med", "high"] },
  },
};

describe("validateAgainstSchema", () => {
  it("accepts a conforming object", () => {
    const result = validateAgainstSchema({ risk: "lost updates", severity: "high" }, RISK_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports missing required fields and enum mismatches", () => {
    const missing = validateAgainstSchema({ risk: "x" }, RISK_SCHEMA);
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(" ")).toContain("severity");

    const badEnum = validateAgainstSchema({ risk: "x", severity: "catastrophic" }, RISK_SCHEMA);
    expect(badEnum.valid).toBe(false);
    expect(badEnum.errors.join(" ")).toContain("allowed values");
  });

  it("rejects non-object values against an object schema", () => {
    expect(validateAgainstSchema("just text", RISK_SCHEMA).valid).toBe(false);
  });
});

describe("extractAgentResult", () => {
  it("prefers .delamain/result.json over the final message", () => {
    const result = extractAgentResult({
      resultFileContent: '{"risk":"from file","severity":"low"}',
      finalResult: '```json\n{"risk":"from message","severity":"high"}\n```',
    });
    expect(result).toEqual({ ok: true, value: { risk: "from file", severity: "low" }, source: "file" });
  });

  it("falls back to the LAST parseable fenced JSON block in the message", () => {
    const result = extractAgentResult({
      finalResult:
        'Some prose.\n```json\n{"risk":"first","severity":"low"}\n```\nmore prose\n```json\n{"risk":"second","severity":"med"}\n```\ndone',
    });
    expect(result).toEqual({ ok: true, value: { risk: "second", severity: "med" }, source: "message" });
  });

  it("falls back past a corrupt result file to the message", () => {
    const result = extractAgentResult({
      resultFileContent: "{not json",
      finalResult: '```\n{"risk":"msg","severity":"high"}\n```',
    });
    expect(result).toEqual({ ok: true, value: { risk: "msg", severity: "high" }, source: "message" });
  });

  it("parses a bare-JSON final message", () => {
    const result = extractAgentResult({ finalResult: '  {"risk":"bare","severity":"low"}  ' });
    expect(result).toEqual({ ok: true, value: { risk: "bare", severity: "low" }, source: "message" });
  });

  it("reports failure when nothing parses", () => {
    const result = extractAgentResult({ finalResult: "I could not produce JSON, sorry." });
    expect(result.ok).toBe(false);
  });
});

describe("prompt builders", () => {
  it("schemaInstruction embeds the schema and both output channels", () => {
    const text = schemaInstruction(RISK_SCHEMA);
    expect(text).toContain(".delamain/result.json");
    expect(text).toContain("fenced JSON");
    expect(text).toContain('"severity"');
  });

  it("schemaRetryPrompt lists every validation error", () => {
    const text = schemaRetryPrompt(["(root) must have required property 'risk'", "/severity must be equal to one of the allowed values"], RISK_SCHEMA);
    expect(text).toContain("required property 'risk'");
    expect(text).toContain("/severity");
    expect(text).toContain(".delamain/result.json");
  });
});
