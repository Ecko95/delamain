import type { DashboardStatus } from "./model.js";

export type Theme = {
  border: string;
  borderFocused: string;
  text: string;
  textDim: string;
  statusColors: Record<DashboardStatus, string>;
  rowRule?: string;
};

export const defaultTheme = {
  border: "#475569",
  borderFocused: "#facc15",
  text: "#e5e7eb",
  textDim: "#94a3b8",
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
} satisfies Theme;

export const cyberpunkTheme = {
  border: "#3a2410",
  borderFocused: "#35e0d8",
  text: "#ffb066",
  textDim: "#8a5a2e",
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
} satisfies Theme;
