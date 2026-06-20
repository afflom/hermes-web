#!/usr/bin/env bash
# TARGET HL-D — the complete agent end to end in the browser: a chat turn calls a tool in the guest,
# writes a session to the OPFS κ-store, and is recoverable after a tab reload; egress via relay or
# direct CORS. Behaviour written first (expected RED). Build to it across Stages B–C + egress wiring.
# Promote to suites/ when green. NON-GATING.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-d-convergence.feature \
  --targets --witness vv/witness/hl-stage-d-convergence.json
