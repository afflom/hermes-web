#!/usr/bin/env bash
# record-cc1.sh — cross-repo toolchain proof: run holospaces' OWN CC-1 conformance (κ-labels equal the
# reference hash implementations) in THIS devcontainer, the substrate authority the HL-1 seal relies on.
# This repo shares the holospaces devcontainer, so the suite runs unchanged. Also `just cc1`.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CLONE=".holo-ref/holospaces"
if [ ! -f "$CLONE/Cargo.toml" ]; then
    echo "holospaces clone absent at $CLONE — clone it (gitignored scratch):"
    echo "  git clone --depth 1 https://github.com/Hologram-Technologies/holospaces $CLONE"
    exit 127
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "CC-1: SKIP — cargo not available (expected present in the holospaces devcontainer)" >&2
    exit 127
fi
mkdir -p vv/witness
log="vv/witness/cc1.log"
cargo test --manifest-path "$CLONE/Cargo.toml" -p holospaces --test cc1_kappa_kat -- --nocapture 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
echo "── CC-1 (holospaces κ-addressing) exit=$rc · log: $log ──"
exit "$rc"
