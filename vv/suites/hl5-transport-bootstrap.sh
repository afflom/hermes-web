#!/usr/bin/env bash
# HL-5 — the dashboard selects + installs its transport at startup (origin / static / hologram) by the
# launcher's signals, wired into the app entry before render; server-hosted builds stay on origin.
# Authority: the source tree. Witness: features/holospaces/stage-c-transport-bootstrap.feature.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-c-transport-bootstrap.feature \
  --witness vv/witness/hl5-transport-bootstrap.json
