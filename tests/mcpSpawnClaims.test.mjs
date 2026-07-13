// tests/mcpSpawnClaims.test.mjs
//
// MCP-boundary coverage for the depends_on / claims spawn params on
// spawn_peer and spawn_peer_and_wait: schema presence in TOOLS plus callTool
// extraction. The extraction tests rely on validation throwing while callTool
// builds the spawnPeer options, before any peer is spawned — if the plumbing
// is ever dropped, the expected error disappears and these fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, callTool } from "../dist/mcpServer.js";

for (const toolName of ["spawn_peer", "spawn_peer_and_wait"]) {
  const tool = TOOLS.find((t) => t.name === toolName);

  test(`${toolName} schema exposes depends_on and claims as string arrays`, () => {
    for (const key of ["depends_on", "claims"]) {
      const prop = tool.inputSchema.properties[key];
      assert.equal(prop?.type, "array", `${key} missing from ${toolName} schema`);
      assert.deepEqual(prop.items, { type: "string" });
    }
  });

  test(`${toolName} schema has no claims_override (MCP stays fail-closed)`, () => {
    assert.equal(tool.inputSchema.properties.claims_override, undefined);
    assert.equal(tool.inputSchema.properties.claimsOverride, undefined);
  });

  test(`callTool ${toolName}: non-string-array depends_on is rejected before spawning`, async () => {
    await assert.rejects(
      callTool(toolName, { repo: "r", prompt: "p", depends_on: [42] }),
      /depends_on must be an array of strings/,
    );
  });

  test(`callTool ${toolName}: camelCase dependsOn alias is read too`, async () => {
    await assert.rejects(
      callTool(toolName, { repo: "r", prompt: "p", dependsOn: [42] }),
      /depends_on must be an array of strings/,
    );
  });

  test(`callTool ${toolName}: non-array claims is rejected before spawning`, async () => {
    await assert.rejects(
      callTool(toolName, { repo: "r", prompt: "p", claims: "src/api" }),
      /claims must be an array of strings/,
    );
  });
}
