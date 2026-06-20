#!/usr/bin/env bash
# HL-4 — the RISC-V loopback boot shim (routed egress + OPFS + loopback ingress) is authored and carried
# in-repo as a patch against holospaces-web, modeled on the AArch64 boot_devcontainer_opfs_full.
# Authority: the holospaces-web source (the patch adds the fn; its wasm32 compile is recorded in
# docs/holospaces/conformance.md via tools/holo/patches/ + vv/witness/holospaces-web-wasm32.log).
# Witness: features/holospaces/stage-c-loopback-shim.feature.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-c-loopback-shim.feature \
  --witness vv/witness/hl4-loopback-shim.json
