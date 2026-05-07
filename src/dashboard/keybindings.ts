import type { DashboardMode } from "./model.js";

export type DashboardCommand =
  | "focus-next"
  | "focus-prev"
  | "select-next"
  | "select-prev"
  | "toggle-details"
  | "scroll-log-down"
  | "scroll-log-up"
  | "page-log-down"
  | "page-log-up"
  | "refresh"
  | "enter-kill-mode"
  | "confirm-kill"
  | "cancel-mode"
  | "quit"
  | "noop";

export function commandForKey(key: string, mode: DashboardMode = "normal"): DashboardCommand {
  if (key === "\u0003" || (mode === "normal" && key === "q")) {
    return "quit";
  }
  if (mode === "kill-confirm") {
    if (key === "\r" || key === "\n") {
      return "confirm-kill";
    }
    if (key === "\x1b") {
      return "cancel-mode";
    }
    return "noop";
  }
  if (key === "\t") {
    return "focus-next";
  }
  if (key === "\x1b[Z") {
    return "focus-prev";
  }
  if (key === "\x1b[B" || key === "j") {
    return "select-next";
  }
  if (key === "\x1b[A" || key === "k") {
    return "select-prev";
  }
  if (key === "\r" || key === "\n" || key === " ") {
    return "toggle-details";
  }
  if (key === "g") {
    return "scroll-log-up";
  }
  if (key === "G") {
    return "scroll-log-down";
  }
  if (key === "\x1b[6~") {
    return "page-log-down";
  }
  if (key === "\x1b[5~") {
    return "page-log-up";
  }
  if (key === "r") {
    return "refresh";
  }
  if (key === "x") {
    return "enter-kill-mode";
  }
  if (key === "\x1b") {
    return "cancel-mode";
  }
  return "noop";
}
