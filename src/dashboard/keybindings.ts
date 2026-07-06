import type { DashboardFocusPane, DashboardMode } from "./model.js";

export type DashboardCommand =
  | "focus-next"
  | "focus-prev"
  | "select-next"
  | "select-prev"
  | "select-left"
  | "select-right"
  | "toggle-details"
  | "scroll-log-down"
  | "scroll-log-up"
  | "page-log-down"
  | "page-log-up"
  | "jump-top"
  | "jump-bottom"
  | "log-bottom"
  | "toggle-status-group"
  | "refresh"
  | "cycle-theme"
  | "enter-kill-mode"
  | "enter-answer-mode"
  | "confirm-kill"
  | "submit-answer"
  | "cancel-mode"
  | "jump-error"
  | "help"
  | "quit"
  | "noop";

export function commandForKey(key: string, mode: DashboardMode = "normal", focusPane: DashboardFocusPane = "peers"): DashboardCommand {
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
  if (mode === "answer") {
    if (key === "\r" || key === "\n") {
      return "submit-answer";
    }
    if (key === "\x1b") {
      return "cancel-mode";
    }
    return "noop";
  }
  if (mode === "help") {
    if (key === "\x1b" || key === "?" || key === "q") {
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
    return focusPane === "logs" ? "scroll-log-down" : "select-next";
  }
  if (key === "\x1b[A" || key === "k") {
    return focusPane === "logs" ? "scroll-log-up" : "select-prev";
  }
  if (key === "h") {
    return "select-left";
  }
  if (key === "l") {
    return "select-right";
  }
  if (key === "\r" || key === "\n" || key === " ") {
    return "toggle-details";
  }
  if (key === "g") {
    return "jump-top";
  }
  if (key === "G") {
    return "jump-bottom";
  }
  if (key === "b" || key === "\x1b[F" || key === "\x1b[4~") {
    return "log-bottom";
  }
  if (key === "\x1b[6~") {
    return "page-log-down";
  }
  if (key === "\x1b[5~") {
    return "page-log-up";
  }
  if (key === "c") {
    return "toggle-status-group";
  }
  if (key === "r") {
    return "refresh";
  }
  if (key === "a") {
    return "enter-answer-mode";
  }
  if (key === "e") {
    return "jump-error";
  }
  if (key === "?") {
    return "help";
  }
  if (key === "t") {
    return "cycle-theme";
  }
  if (key === "x") {
    return "enter-kill-mode";
  }
  if (key === "\x1b") {
    return "cancel-mode";
  }
  return "noop";
}
