import { kill } from "node:process";

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killPid(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    kill(-pid, signal);
    return true;
  } catch {
    return killPid(pid, signal);
  }
}
