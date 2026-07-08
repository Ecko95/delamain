// ponytail: throwaway type-check probe for 02-RESEARCH.md Open Question 2 — delete once Plan 05 lands.
// Verdict: FACTORY. `ScrollBox` is defined the same way as `Box`/`Text` in
// node_modules/@opentui/core/index-4w8751xf.js: `function ScrollBox(props, ...children) { return h(ScrollBoxRenderable, props || {}, ...children); }`
// Plan 05 uses: ScrollBox({ stickyScroll: true, stickyStart: "bottom", scrollY: true, ...opts }, ...children)
import { ScrollBox, Text } from "@opentui/core";

const probe = ScrollBox({ stickyScroll: true, stickyStart: "bottom", scrollY: true, height: 5, width: "100%" }, Text({ content: "x" }));

void probe;
