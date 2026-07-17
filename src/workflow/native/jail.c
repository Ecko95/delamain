/*
 * delamain workflow sandbox jail (SP1 wave 2, spec §7).
 *
 * The real security boundary around the workflow sandbox child. node:vm is
 * only a language boundary; this helper is the OS jail. It applies, in order:
 *   1. PR_SET_NO_NEW_PRIVS               (required for unprivileged seccomp)
 *   2. Landlock filesystem restriction   (deny read/write/exec outside allow)
 *   3. seccomp syscall filter            (block socket/connect/bind/exec/ptrace)
 * then execve()s the real command (node + the sandbox-child entry).
 *
 * Every layer is best-effort and verified at startup: if a primitive is
 * unavailable on this host, we print
 *   SANDBOX DEGRADED: <layer> unavailable — trusted scripts only
 * to stderr and continue (unless DELAMAIN_JAIL_STRICT=1, which makes any
 * missing layer fatal so a capable host cannot silently run unjailed).
 *
 * Network namespaces need unprivileged user-namespaces, which are commonly
 * disabled (e.g. AppArmor apparmor_restrict_unprivileged_userns=1 on WSL2/
 * Ubuntu). We therefore do NOT rely on a netns; the seccomp socket block is
 * the network boundary, per spec §7.
 *
 * Env contract (all colon-separated path lists; empty/unset = none):
 *   DELAMAIN_JAIL_RO    read-only allow paths (dirs or files)
 *   DELAMAIN_JAIL_RW    read-write allow paths (scratch/worktree)
 *   DELAMAIN_JAIL_EXEC  files granted EXECUTE (the node binary + loader)
 *   DELAMAIN_JAIL_STRICT "1" => a missing layer is fatal (exit 78)
 *   DELAMAIN_JAIL_ALLOW_NET "1" => skip the seccomp socket block (debug only)
 *
 * argv: jail <cmd> [args...]
 */
#define _GNU_SOURCE
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <stdint.h>

#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif

#define EXIT_JAIL_STRICT 78

static int g_strict = 0;
static int g_degraded = 0;

static void degrade(const char *layer, const char *why) {
  fprintf(stderr, "SANDBOX DEGRADED: %s unavailable — trusted scripts only (%s)\n", layer, why);
  g_degraded = 1;
}

/* --- Landlock ------------------------------------------------------------ */

static int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, uint32_t flags) {
  return (int)syscall(SYS_landlock_create_ruleset, attr, size, flags);
}
static int landlock_add_rule(int fd, enum landlock_rule_type t, const void *attr, uint32_t flags) {
  return (int)syscall(SYS_landlock_add_rule, fd, t, attr, flags);
}
static int landlock_restrict_self(int fd, uint32_t flags) {
  return (int)syscall(SYS_landlock_restrict_self, fd, flags);
}

/* Access-right bit groups, masked to the running ABI below. */
#define LL_FS_READ (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define LL_FS_WRITE                                                            \
  (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |             \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |            \
   LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |               \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |             \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM)

static int add_path(int ruleset_fd, const char *path, uint64_t allowed) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    /* Missing allow-path is not fatal: just can't grant what isn't there. */
    return 0;
  }
  struct landlock_path_beneath_attr pb = {0};
  pb.allowed_access = allowed;
  pb.parent_fd = fd;
  int rc = landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
  int saved = errno;
  close(fd);
  if (rc) {
    errno = saved;
    return -1;
  }
  return 0;
}

static void add_list(int ruleset_fd, const char *env, uint64_t allowed) {
  const char *raw = getenv(env);
  if (!raw || !*raw) return;
  char *dup = strdup(raw);
  if (!dup) return;
  for (char *tok = strtok(dup, ":"); tok; tok = strtok(NULL, ":")) {
    if (*tok) add_path(ruleset_fd, tok, allowed);
  }
  free(dup);
}

static int g_nnp = 0;

/* NO_NEW_PRIVS is a prerequisite for BOTH unprivileged Landlock restrict_self
 * and seccomp; set it once, before either layer. */
static void apply_no_new_privs(void) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0) {
    g_nnp = 1;
  } else {
    degrade("no_new_privs", strerror(errno));
  }
}

static void apply_landlock(void) {
  int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    degrade("landlock", abi < 0 ? strerror(errno) : "abi<1");
    return;
  }

  uint64_t handled = LL_FS_READ | LL_FS_WRITE | LANDLOCK_ACCESS_FS_EXECUTE;
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
  /* ABI>=4 adds TCP bind/connect handling; we leave network to seccomp. */

  struct landlock_ruleset_attr attr = {0};
  attr.handled_access_fs = handled;
  int ruleset_fd = landlock_create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset_fd < 0) {
    degrade("landlock", strerror(errno));
    return;
  }

  uint64_t ro = LL_FS_READ & handled;
  uint64_t rw = (LL_FS_READ | LL_FS_WRITE | LANDLOCK_ACCESS_FS_TRUNCATE) & handled;
  uint64_t ex = (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE) & handled;
  add_list(ruleset_fd, "DELAMAIN_JAIL_RO", ro);
  add_list(ruleset_fd, "DELAMAIN_JAIL_RW", rw);
  add_list(ruleset_fd, "DELAMAIN_JAIL_EXEC", ex);

  if (landlock_restrict_self(ruleset_fd, 0)) {
    degrade("landlock", strerror(errno));
    close(ruleset_fd);
    return;
  }
  close(ruleset_fd);
}

/* --- seccomp ------------------------------------------------------------- */

#if defined(__x86_64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_AARCH64
#else
#define AUDIT_ARCH_NATIVE 0
#endif

static void apply_seccomp(int block_net) {
  if (AUDIT_ARCH_NATIVE == 0) {
    degrade("seccomp", "unsupported arch");
    return;
  }
  if (!g_nnp) {
    degrade("seccomp", "no_new_privs not set");
    return;
  }

  /*
   * Default ALLOW; deny a small deny-list with EPERM so the workload observes
   * a kernel-level failure (not a crash). execve is intentionally NOT blocked
   * here — we rely on Landlock withholding EXECUTE from every path except the
   * node binary/loader, which avoids the "block execve after our own execve"
   * bootstrap problem while still stopping the workload from exec'ing a shell.
   */
#define DENY(nr)                                                               \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1),                             \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

/*
 * On x86-64 the deny-list matches native syscall numbers only, so an x32
 * syscall (same arch, nr | 0x40000000) would slip past it. Deny every x32
 * syscall up front — node uses the native ABI exclusively, so this can't break
 * legitimate use. No-op on non-x86-64 (no X32 bit).
 */
#if defined(__x86_64__)
#define X32_GUARD                                                              \
  BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),                       \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
#else
#define X32_GUARD
#endif

  struct sock_filter net_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_NATIVE, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    X32_GUARD
#ifdef __NR_socket
    DENY(__NR_socket),
#endif
#ifdef __NR_socketpair
    DENY(__NR_socketpair),
#endif
#ifdef __NR_connect
    DENY(__NR_connect),
#endif
#ifdef __NR_bind
    DENY(__NR_bind),
#endif
#ifdef __NR_ptrace
    DENY(__NR_ptrace),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };

  /* Without the net block we still want NO_NEW_PRIVS + ptrace deny. */
  struct sock_filter min_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_NATIVE, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    X32_GUARD
#ifdef __NR_ptrace
    DENY(__NR_ptrace),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
#undef DENY
#undef X32_GUARD

  struct sock_fprog prog;
  if (block_net) {
    prog.len = (unsigned short)(sizeof(net_filter) / sizeof(net_filter[0]));
    prog.filter = net_filter;
  } else {
    prog.len = (unsigned short)(sizeof(min_filter) / sizeof(min_filter[0]));
    prog.filter = min_filter;
  }
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog)) {
    /* Fall back to classic prctl path before giving up. */
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0)) {
      degrade("seccomp", strerror(errno));
    }
  }
}

/* --- main ---------------------------------------------------------------- */

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "jail: usage: jail <cmd> [args...]\n");
    return 2;
  }
  g_strict = getenv("DELAMAIN_JAIL_STRICT") && !strcmp(getenv("DELAMAIN_JAIL_STRICT"), "1");
  int block_net = !(getenv("DELAMAIN_JAIL_ALLOW_NET") && !strcmp(getenv("DELAMAIN_JAIL_ALLOW_NET"), "1"));

  apply_no_new_privs();
  apply_landlock();
  apply_seccomp(block_net);

  if (g_strict && g_degraded) {
    fprintf(stderr, "jail: STRICT mode and one or more layers degraded — refusing to run\n");
    return EXIT_JAIL_STRICT;
  }

  execv(argv[1], &argv[1]);
  fprintf(stderr, "jail: execv(%s) failed: %s\n", argv[1], strerror(errno));
  return 127;
}
