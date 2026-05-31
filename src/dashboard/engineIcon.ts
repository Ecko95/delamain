import type { PeerEngine } from "../types.js";

export type EngineIconStyle = "nerd" | "ascii";

/**
 * Resolve the icon style for the running terminal. Defaults to Nerd Font
 * glyphs; opt into plain ASCII markers with `DELAMAIN_ICONS=ascii` (or
 * `DELAMAIN_ASCII_ICONS=1`) when the terminal font lacks Nerd glyphs.
 */
export function engineIconStyle(env: NodeJS.ProcessEnv = process.env): EngineIconStyle {
	const explicit = (env.DELAMAIN_ICONS ?? "").toLowerCase();
	if (explicit === "ascii" || env.DELAMAIN_ASCII_ICONS === "1") {
		return "ascii";
	}
	return "nerd";
}

export type EngineIcon = { text: string; color: string; label: string };

type EngineIconSpec = { glyph: string; ascii: string; color: string; label: string };

// Per-engine markers for the dashboard peer list.
//
// Each engine gets a distinct Nerd Font robot/bot glyph in its own accent
// colour: codex → a solid robot (nf-md-robot), cursor → an outline robot
// (nf-md-robot-outline). Solid-vs-outline reads as two different bots even
// before colour. These are bot icons, not official brand logos.
//
// To use exact brand glyphs from your own patched font without rebuilding, set
// DELAMAIN_ICON_CURSOR / DELAMAIN_ICON_CODEX to the single character to render.
const SPECS: Record<PeerEngine, EngineIconSpec> = {
	// \u{f167a} = nf-md-robot-outline (cursor); \u{f06a9} = nf-md-robot (codex).
	cursor: { glyph: "\u{f167a}", ascii: "CU", color: "#a855f7", label: "cursor" },
	codex: { glyph: "\u{f06a9}", ascii: "CX", color: "#10a37f", label: "codex" },
};

function normalizeEngine(engine: PeerEngine | undefined): PeerEngine {
	return engine === "cursor" ? "cursor" : "codex";
}

export function engineIcon(
	engine: PeerEngine | undefined,
	style: EngineIconStyle = engineIconStyle(),
	env: NodeJS.ProcessEnv = process.env,
): EngineIcon {
	const key = normalizeEngine(engine);
	const spec = SPECS[key];
	let glyph = spec.glyph;
	const override = key === "cursor" ? env.DELAMAIN_ICON_CURSOR : env.DELAMAIN_ICON_CODEX;
	if (override) {
		glyph = override;
	}
	return { text: style === "nerd" ? glyph : spec.ascii, color: spec.color, label: spec.label };
}

/**
 * Fixed-width (2-cell) engine cell for aligned table rows: a Nerd glyph plus a
 * trailing space, or the 2-char ASCII marker.
 */
export function engineCell(
	engine: PeerEngine | undefined,
	style: EngineIconStyle = engineIconStyle(),
	env: NodeJS.ProcessEnv = process.env,
): EngineIcon {
	const icon = engineIcon(engine, style, env);
	const text = style === "nerd" ? `${icon.text} ` : icon.text.padEnd(2).slice(0, 2);
	return { ...icon, text };
}
