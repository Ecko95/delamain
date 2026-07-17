// src/workflow/jail.ts
//
// SP1 wave 2 — host-side wiring for the native OS jail (native/jail.c). Builds
// the spawn command that wraps the sandbox child in NO_NEW_PRIVS + Landlock +
// seccomp, and reports which layers are active on this host. On a platform or
// kernel that can't jail, callers fall back to spawning node directly and
// surface a loud degraded-mode warning (spec §7).

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
// Compiled by scripts/build-jail.sh at `npm run build`; lazily built on first
// use if missing (so `tsc`-only checkouts and tests still get a jail).
const JAIL_BIN = join(HERE, "native", "jail");
const JAIL_SRC = join(HERE, "..", "..", "src", "workflow", "native", "jail.c");

export type JailPlan = {
  /** True when the jail binary is available and this is Linux. */
  available: boolean;
  /** argv[0] to spawn (jail binary) or undefined when unavailable. */
  command?: string;
  /** Args placed before the wrapped command (none today; env carries policy). */
  prefixArgs: string[];
  /** Env additions describing the Landlock allow-lists + seccomp policy. */
  env: Record<string, string>;
  /** Human-readable reason when unavailable (for the degraded warning). */
  reason?: string;
};

let cachedBinary: string | undefined | null;

/** Absolute path to a usable jail binary, or null if it can't be built. */
export function resolveJailBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  if (process.platform !== "linux") {
    cachedBinary = null;
    return null;
  }
  if (existsSync(JAIL_BIN)) {
    cachedBinary = JAIL_BIN;
    return cachedBinary;
  }
  // Lazy compile (dev/test checkouts that ran tsc without the build script).
  try {
    if (existsSync(JAIL_SRC)) {
      mkdirSync(dirname(JAIL_BIN), { recursive: true });
      execFileSync("cc", ["-O2", "-o", JAIL_BIN, JAIL_SRC], { stdio: "ignore" });
      if (existsSync(JAIL_BIN)) {
        cachedBinary = JAIL_BIN;
        return cachedBinary;
      }
    }
  } catch {
    /* no compiler / headers — degrade */
  }
  cachedBinary = null;
  return null;
}

function existingPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    try {
      const real = realpathSync(p);
      if (existsSync(real)) seen.add(real);
    } catch {
      if (existsSync(p)) seen.add(p);
    }
  }
  return [...seen];
}

/**
 * Build the jail plan for a sandbox child: node needs read access to its own
 * runtime + the child entry; write access only to a private scratch dir;
 * EXECUTE only on the node binary + ELF interpreter (so the workload cannot
 * exec a shell). Everything else is denied by Landlock; sockets by seccomp.
 */
export function buildJailPlan(opts: { childPath: string; scratchDir: string; strict?: boolean }): JailPlan {
  const binary = resolveJailBinary();
  if (!binary) {
    return {
      available: false,
      prefixArgs: [],
      env: {},
      reason:
        process.platform !== "linux"
          ? `OS jail is Linux-only (platform=${process.platform})`
          : "no jail binary and no C toolchain to build one",
    };
  }

  const node = realpathSync(process.execPath);
  const nodeDir = dirname(node);
  const roPaths = existingPaths([
    "/usr/lib",
    "/usr/lib64",
    "/lib",
    "/lib64",
    "/usr/local/lib",
    // node reads several /etc files at startup (ssl config, nsswitch, tz). The
    // meaningful "outside the worktree" boundary is the user's source tree and
    // other tenants' data — /home, /srv, /root, arbitrary /tmp — which stay
    // denied; /etc holds no workflow secrets.
    "/etc",
    "/proc",
    "/sys",
    "/dev/null",
    "/dev/zero",
    "/dev/urandom",
    "/dev/random",
    nodeDir,
    dirname(opts.childPath),
    join(HERE, "native"),
  ]);
  // Only the private scratch dir is writable — NOT the whole tmp root, so a
  // secret dropped elsewhere in /tmp is unreadable to the jailed child.
  const rwPaths = existingPaths([opts.scratchDir]);

  // node needs EXECUTE on itself AND on its dynamic loader (Landlock checks the
  // interpreter during execve). Resolve the loader from node's own ELF
  // PT_INTERP; if that can't be found on disk we would produce a broken EXEC
  // list where node silently fails to start under the jail — degrade LOUDLY
  // instead (spec §7), so the run continues unjailed with a warning rather than
  // hard-failing with an opaque "child exited unexpectedly".
  const interp = resolveElfInterpreter(node);
  if (interp === "unresolvable") {
    return {
      available: false,
      prefixArgs: [],
      env: {},
      reason: "could not resolve node's ELF interpreter (dynamic loader); would break execve under Landlock",
    };
  }
  const execPaths = existingPaths(interp === "static" ? [node] : [node, interp]);

  return {
    available: true,
    command: binary,
    prefixArgs: [],
    env: {
      DELAMAIN_JAIL_RO: roPaths.join(":"),
      DELAMAIN_JAIL_RW: rwPaths.join(":"),
      DELAMAIN_JAIL_EXEC: execPaths.join(":"),
      ...(opts.strict ? { DELAMAIN_JAIL_STRICT: "1" } : {}),
    },
    reason: undefined,
  };
}

/**
 * Read the dynamic loader path from an ELF binary's PT_INTERP segment.
 * Returns the interpreter path, "static" (no PT_INTERP → no loader needed), or
 * "unresolvable" (PT_INTERP present but the file is missing, or the ELF can't
 * be parsed). 64-bit little-endian ELF (x86-64/arm64); anything else falls back
 * to the common loader guesses.
 */
function resolveElfInterpreter(binary: string): string | "static" | "unresolvable" {
  try {
    const fd = openSync(binary, "r");
    try {
      const header = Buffer.alloc(64);
      readSync(fd, header, 0, 64, 0);
      if (header.readUInt32LE(0) !== 0x464c457f) return guessInterpreter(); // not ELF magic
      const is64 = header[4] === 2;
      const isLE = header[5] === 1;
      if (!is64 || !isLE) return guessInterpreter();
      const phoff = Number(header.readBigUInt64LE(0x20));
      const phentsize = header.readUInt16LE(0x36);
      const phnum = header.readUInt16LE(0x38);
      const PT_INTERP = 3;
      for (let i = 0; i < phnum; i += 1) {
        const ph = Buffer.alloc(phentsize);
        readSync(fd, ph, 0, phentsize, phoff + i * phentsize);
        if (ph.readUInt32LE(0) === PT_INTERP) {
          const pOffset = Number(ph.readBigUInt64LE(0x08));
          const pFilesz = Number(ph.readBigUInt64LE(0x20));
          const buf = Buffer.alloc(pFilesz);
          readSync(fd, buf, 0, pFilesz, pOffset);
          const interp = buf.toString("utf8").replace(/\0.*$/, "").trim();
          if (!interp) return "unresolvable";
          return existsSync(interp) ? interp : "unresolvable";
        }
      }
      return "static"; // no PT_INTERP → statically linked, no loader to grant
    } finally {
      closeSync(fd);
    }
  } catch {
    return guessInterpreter();
  }
}

/** Fallback when the ELF can't be parsed: common glibc loaders, or unresolvable. */
function guessInterpreter(): string | "unresolvable" {
  for (const p of ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1", "/lib64/ld-linux-aarch64.so.1"]) {
    if (existsSync(p)) return p;
  }
  return "unresolvable";
}

export type JailProbe = {
  supported: boolean;
  layers: { landlock: boolean; seccomp: boolean; noNewPrivs: boolean };
  degraded: string[];
  reason?: string;
};

/**
 * Verify the jail actually engages on this host by running the binary over a
 * tiny probe and reading its degraded-mode warnings from stderr. Cached.
 */
let cachedProbe: JailProbe | undefined;
export function probeJail(): JailProbe {
  if (cachedProbe) return cachedProbe;
  const binary = resolveJailBinary();
  if (!binary) {
    cachedProbe = {
      supported: false,
      layers: { landlock: false, seccomp: false, noNewPrivs: false },
      degraded: ["landlock", "seccomp", "no_new_privs"],
      reason: process.platform !== "linux" ? `platform=${process.platform}` : "no jail binary",
    };
    return cachedProbe;
  }
  const scratch = mkdtempScratch();
  const node = realpathSync(process.execPath);
  const plan = buildJailPlan({ childPath: node, scratchDir: scratch });
  // Run node (in the EXEC allow-list) under the jail; parse degraded warnings.
  // A non-jailed binary like /bin/true is intentionally NOT executable under
  // the jail, so it would be a false negative here.
  const res = spawnSync(binary, [node, "-e", "process.exit(0)"], {
    env: { ...process.env, ...plan.env },
    encoding: "utf8",
  });
  const stderr = res.stderr || "";
  const degraded: string[] = [];
  for (const layer of ["landlock", "seccomp", "no_new_privs"]) {
    if (stderr.includes(`SANDBOX DEGRADED: ${layer}`)) degraded.push(layer);
  }
  cachedProbe = {
    supported: res.status === 0 || res.status === null,
    layers: {
      landlock: !degraded.includes("landlock"),
      seccomp: !degraded.includes("seccomp"),
      noNewPrivs: !degraded.includes("no_new_privs"),
    },
    degraded,
    reason: degraded.length ? `degraded: ${degraded.join(", ")}` : undefined,
  };
  return cachedProbe;
}

function mkdtempScratch(): string {
  const dir = join(tmpdir(), `delamain-jailprobe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return existsSync(dir) ? dir : tmpdir();
}

/** Test/introspection helper. */
export function jailPathsExist(): boolean {
  return existsSync(JAIL_SRC) || existsSync(JAIL_BIN);
}
