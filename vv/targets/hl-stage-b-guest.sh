#!/usr/bin/env bash
# TARGET HL-B — the unmodified Python Hermes boots inside the in-browser RISC-V guest, state on the
# OPFS κ-store. Behaviour written first (expected RED). Build to it: a linux/riscv64 OCI image + a
# riscv64 kernel, booted via holospaces-web boot_devcontainer_routed_opfs_streamed. Promote to suites/
# when green. NON-GATING.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-b-guest.feature \
  --targets --witness vv/witness/hl-stage-b-guest.json
