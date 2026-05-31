import test from "node:test";
import assert from "node:assert/strict";
import { engineIcon, engineIconStyle, engineCell } from "../dist/dashboard/engineIcon.js";

test("engineIconStyle defaults to nerd, opts out via env", () => {
	assert.equal(engineIconStyle({}), "nerd");
	assert.equal(engineIconStyle({ DELAMAIN_ICONS: "ascii" }), "ascii");
	assert.equal(engineIconStyle({ DELAMAIN_ASCII_ICONS: "1" }), "ascii");
});

test("engineIcon returns distinct glyph + colour per engine", () => {
	const cursor = engineIcon("cursor", "nerd");
	const codex = engineIcon("codex", "nerd");
	assert.notEqual(cursor.text, codex.text);
	assert.notEqual(cursor.color, codex.color);
	assert.equal(cursor.label, "cursor");
	assert.equal(codex.label, "codex");
});

test("ascii style yields plain 2-char markers", () => {
	assert.equal(engineIcon("cursor", "ascii").text, "CU");
	assert.equal(engineIcon("codex", "ascii").text, "CX");
});

test("undefined engine falls back to codex", () => {
	assert.equal(engineIcon(undefined, "ascii").text, "CX");
});

test("env override swaps the glyph without changing colour", () => {
	const out = engineIcon("cursor", "nerd", { DELAMAIN_ICON_CURSOR: "X" });
	assert.equal(out.text, "X");
	assert.equal(out.color, engineIcon("cursor", "nerd").color);
});

test("engineCell pads ascii markers to a fixed width", () => {
	assert.equal(engineCell("codex", "ascii").text.length, 2);
	// nerd cell is glyph + trailing space
	assert.ok(engineCell("codex", "nerd").text.endsWith(" "));
});
