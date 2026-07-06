// Parse a raw ANSI capture (from `script`) and rebuild the terminal grid.
// Usage: node scripts/reconstruct.mjs <file> <cols> <rows>
import { readFileSync } from "node:fs";

const [file, colsArg, rowsArg] = process.argv.slice(2);
const COLS = Number(colsArg) || 160;
const ROWS = Number(rowsArg) || 45;
let data = readFileSync(file, "latin1");

const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
let cx = 0;
let cy = 0;
let i = 0;

const width = (ch) => {
  const cp = ch.codePointAt(0);
  // rough wide-char detection for CJK/emoji ranges
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f000) || (cp >= 0x2600 && cp <= 0x27bf))) return 2;
  return 1;
};

while (i < data.length) {
  const ch = data[i];
  if (ch === "\x1b") {
    const rest = data.slice(i);
    let m;
    if ((m = /^\x1b\[(\d*);(\d*)H/.exec(rest))) { cy = (Number(m[1]) || 1) - 1; cx = (Number(m[2]) || 1) - 1; i += m[0].length; continue; }
    if ((m = /^\x1b\[(\d*)H/.exec(rest))) { cy = (Number(m[1]) || 1) - 1; cx = 0; i += m[0].length; continue; }
    if ((m = /^\x1b\[2J/.exec(rest))) { for (const r of grid) r.fill(" "); i += m[0].length; continue; }
    if ((m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^\x1b[()][AB0]/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^\x1b[=>]/.exec(rest))) { i += m[0].length; continue; }
    i += 1; continue;
  }
  if (ch === "\r") { cx = 0; i += 1; continue; }
  if (ch === "\n") { cy += 1; cx = 0; i += 1; continue; }
  if (ch === "\b") { cx = Math.max(0, cx - 1); i += 1; continue; }
  if (ch < " ") { i += 1; continue; }
  // decode utf-8 sequence from latin1 buffer
  let cp = data.codePointAt(i);
  let bytes = 1;
  const c0 = data.charCodeAt(i);
  if (c0 >= 0xf0) bytes = 4; else if (c0 >= 0xe0) bytes = 3; else if (c0 >= 0xc0) bytes = 2;
  const raw = Buffer.from(data.slice(i, i + bytes), "latin1");
  const dec = raw.toString("utf8");
  const glyph = dec[0] || ch;
  if (cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS) grid[cy][cx] = glyph;
  cx += width(glyph);
  i += bytes;
}

console.log(grid.map((r) => r.join("").replace(/\s+$/, "")).join("\n"));
