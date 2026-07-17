#!/usr/bin/env bash
# Compile the workflow sandbox OS-jail helper (SP1 wave 2).
#
# Best-effort: on a non-Linux host or without a C toolchain, we skip and let
# the sandbox degrade loudly at runtime (trusted scripts only). The build must
# not fail just because the jail can't be compiled here.
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/src/workflow/native/jail.c"
out_dir="$root/dist/workflow/native"
out="$out_dir/jail"

if [ "$(uname -s)" != "Linux" ]; then
  echo "[build-jail] non-Linux ($(uname -s)); skipping jail compile (sandbox will degrade loudly)"
  exit 0
fi
if ! command -v cc >/dev/null 2>&1; then
  echo "[build-jail] no C compiler; skipping jail compile (sandbox will degrade loudly)"
  exit 0
fi
if [ ! -f "$src" ]; then
  echo "[build-jail] missing $src; skipping"
  exit 0
fi

mkdir -p "$out_dir"
if cc -O2 -Wall -o "$out" "$src" 2>"$out_dir/jail-build.log"; then
  echo "[build-jail] compiled $out"
else
  echo "[build-jail] compile failed (see $out_dir/jail-build.log); sandbox will degrade loudly"
fi
exit 0
