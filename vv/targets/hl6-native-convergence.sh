#!/usr/bin/env bash
# TARGET HL-6 — native convergence: the Hermes guest boots, serves /api/status over the in-process
# loopback bridge, and the warm machine snapshots + resumes byte-identically — on the holospaces RISC-V
# emulator (the same instruction-interpreter the browser runs via wasm). GREEN once the on-demand witness
# (tools/holo/witness/run-hermes-guest.sh, ~24 min) has recorded its proof to vv/witness/; RED — and
# NON-GATING — in the CI deploy gate, where the heavy boot is not run and vv/witness is regenerated. When
# the witness artifacts are committed or made regenerable in the gate, promote → vv/suites/.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/native-convergence.feature \
  --targets --witness vv/witness/hl6-native-convergence.json
