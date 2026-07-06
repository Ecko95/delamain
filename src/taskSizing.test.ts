import { afterEach, describe, expect, it } from "vitest";
import { checkTaskSize } from "./taskSizing.js";

afterEach(() => {
  delete process.env.DELAMAIN_SIZING_PROMPT_WARN;
  delete process.env.DELAMAIN_SIZING_FILES_WARN;
  delete process.env.DELAMAIN_SIZING_PACKAGES_WARN;
});

describe("checkTaskSize", () => {
  it("ok when everything is under the limits", () => {
    const result = checkTaskSize({
      prompt: "small task",
      scope: { files: 3, packages: 1 },
    });
    expect(result.level).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  it("warns on an oversized brief", () => {
    const result = checkTaskSize({ prompt: "x".repeat(12_001) });
    expect(result.level).toBe("warn");
    expect(result.reasons.join(" ")).toMatch(/chars/);
  });

  it("warns when too many files are declared", () => {
    const result = checkTaskSize({ prompt: "task", scope: { files: 9 } });
    expect(result.level).toBe("warn");
    expect(result.reasons.join(" ")).toMatch(/files/);
  });

  it("warns on cross-package scope without enumerated downstream", () => {
    const result = checkTaskSize({ prompt: "shared contract change", scope: { packages: 2 } });
    expect(result.level).toBe("warn");
    expect(result.reasons.join(" ")).toMatch(/downstream/);
  });

  it("ok on cross-package scope WITH downstream enumerated", () => {
    const result = checkTaskSize({
      prompt: "shared contract change",
      scope: { packages: 2, downstream: ["packages/x/fixtures/a.json"] },
    });
    expect(result.level).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  it("size_override suppresses the warning but keeps reasons for logging", () => {
    const result = checkTaskSize({
      prompt: "x".repeat(12_001),
      scope: { files: 20 },
      sizeOverride: true,
    });
    expect(result.level).toBe("ok");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("honours env-tunable thresholds", () => {
    process.env.DELAMAIN_SIZING_FILES_WARN = "2";
    const result = checkTaskSize({ prompt: "task", scope: { files: 3 } });
    expect(result.level).toBe("warn");
  });
});
