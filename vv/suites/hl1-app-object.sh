#!/usr/bin/env bash
# HL-1 — the hermes-web dashboard seals as a holospace app object and folds into the frame.
# Authority: the vendored os-holo κ primitives (re-derivation, Law L5) + the frame's os-closure/catalog.
# Witness: features/holospaces/stage-a-app-object.feature (run by tools/holo/bdd.mjs). @pinned is skipped
# here — the exact root κ is build-environment sensitive; determinism + structure are the gating witness.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-a-app-object.feature \
  --skip-tags @pinned --witness vv/witness/hl1-app-object.json
