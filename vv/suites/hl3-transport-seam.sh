#!/usr/bin/env bash
# HL-3 — the dashboard data layer has a single, swappable transport seam.
# Authority: the source tree itself (static property) — no WebSocket/raw fetch is constructed outside
# api.ts, and api.ts exposes the REST + socket swap points (setFetchImpl/setSocketFactory/openSocket).
# Witness: features/holospaces/stage-c-transport.feature minus the @pending live scenario (a target).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-c-transport.feature \
  --skip-tags @pending --witness vv/witness/hl3-transport-seam.json
