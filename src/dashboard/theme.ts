import type { DashboardStatus } from "./model.js";

export type Theme = {
  border: string;
  borderFocused: string;
  text: string;
  textDim: string;
  accent: string;
  selBg: string;
  selFg: string;
  statusColors: Record<DashboardStatus, string>;
  rowRule?: string;
  ramp: [string, string, string];
  cyanBand: string;
  chipBg: string;
  chipFg: string;
};

export const defaultTheme = {
  border: "#475569",
  borderFocused: "#facc15",
  text: "#e5e7eb",
  textDim: "#94a3b8",
  accent: "#facc15",
  selBg: "#334155",
  selFg: "#ffffff",
  statusColors: {
    starting: "#60a5fa",
    working: "#22d3ee",
    waiting: "#facc15",
    idle: "#94a3b8",
    done: "#a3a3a3",
    cleanup: "#34d399",
    failed: "#f87171",
    frozen: "#c084fc",
    killed: "#fb923c",
    gsd_pending: "#818cf8",
    gsd_running_phase: "#22d3ee",
    gsd_polling_state: "#60a5fa",
    gsd_running_gate_check: "#fbbf24",
    gsd_halted_on_gate_failure: "#c084fc",
    gsd_completed: "#34d399",
    gsd_failed: "#f87171",
  },
  ramp: ["#0b1220", "#131c2e", "#1b2740"],
  cyanBand: "#1e293b",
  chipBg: "#334155",
  chipFg: "#e5e7eb",
} satisfies Theme;

export const cyberpunkTheme = {
  border: "#3a2410",
  borderFocused: "#35e0d8",
  text: "#ffb066",
  textDim: "#8a5a2e",
  accent: "#ff7a1a",
  selBg: "#7a3d0d",
  selFg: "#ffffff",
  statusColors: {
    starting: "#35e0d8",
    working: "#ff7a1a",
    waiting: "#35e0d8",
    idle: "#8a5a2e",
    done: "#8a5a2e",
    cleanup: "#ffb066",
    failed: "#ff4433",
    frozen: "#35e0d8",
    killed: "#ff4433",
    gsd_pending: "#8a5a2e",
    gsd_running_phase: "#ff7a1a",
    gsd_polling_state: "#35e0d8",
    gsd_running_gate_check: "#35e0d8",
    gsd_halted_on_gate_failure: "#ff4433",
    gsd_completed: "#ffb066",
    gsd_failed: "#ff4433",
  },
  rowRule: "─",
  ramp: ["#100a04", "#1a1006", "#2a1808"],
  cyanBand: "#0e2624",
  chipBg: "#3a2410",
  chipFg: "#ffb066",
} satisfies Theme;

const mutedCache = new Map<Theme, Theme>();

export function mutedTheme(theme: Theme): Theme {
  const cached = mutedCache.get(theme);
  if (cached) {
    return cached;
  }
  const cyberpunk = theme === cyberpunkTheme;
  const fg = cyberpunk ? "#2a1808" : "#1e293b";
  const rule = cyberpunk ? "#1a1006" : "#111827";
  const status = cyberpunk ? "#3a2410" : "#1f2937";
  const sel = cyberpunk ? "#0d0702" : "#0b1220";
  const mutedStatus = {} as Theme["statusColors"];
  for (const key of Object.keys(theme.statusColors) as Array<keyof Theme["statusColors"]>) {
    mutedStatus[key] = status;
  }
  const muted: Theme = {
    ...theme,
    text: fg,
    textDim: fg,
    accent: fg,
    border: rule,
    borderFocused: rule,
    selFg: fg,
    selBg: sel,
    statusColors: mutedStatus,
  };
  mutedCache.set(theme, muted);
  return muted;
}
