#!/usr/bin/env bash
# TARGET HL-C — the hologram transport reaches the REAL in-guest web_server.py over the loopback bridge
# (a live round-trip, not the codec in isolation — HL-2 already witnesses the wire). Behaviour written
# first (expected RED). Build to it: the RISC-V routed_opfs+enable_loopback boot fn in holospaces-web
# (modeled on the AArch64 boot_devcontainer_opfs_full) + installHologramTransport. NON-GATING.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-c-transport.feature \
  --tags @stage-c-live --targets --witness vv/witness/hl-stage-c-live.json
