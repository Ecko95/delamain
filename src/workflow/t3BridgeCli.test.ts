import { afterEach, describe, expect, it, vi } from "vitest";
import { runT3Bridge } from "../cli.js";

// Smallest wiring check: the disabled path must gate on the three env vars,
// name them, exit non-zero, and NOT enter startT3Bridge's tail loop (which
// would hang). If the null-guard wiring breaks, this test fails/hangs.
describe("runT3Bridge (cli wiring)", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("is disabled without all three env vars: names them and exits non-zero", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runT3Bridge({ T3_BASE_URL: "http://t3" }); // missing T3_TOKEN / T3_PROJECT_ID
    expect(process.exitCode).toBe(1);
    const msg = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("T3_BASE_URL");
    expect(msg).toContain("T3_TOKEN");
    expect(msg).toContain("T3_PROJECT_ID");
  });
});
