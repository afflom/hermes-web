#!/usr/bin/env bash
# record-substrate.sh — execute, in THIS shared devcontainer, the holospaces conformance suites that are
# the EXTERNAL AUTHORITIES for the Stage-B/C targets, and build the in-browser emulator codemodule.
# These prove the RISC-V guest substrate the Hermes lift boots onto is real and runs here. Also `just`
# can call it. Writes logs under vv/witness/.
#
#   tools/holo/record-substrate.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CLONE=".holo-ref/holospaces"
mkdir -p vv/witness
if [ ! -f "$CLONE/Cargo.toml" ]; then
    echo "holospaces clone absent at $CLONE — clone it (gitignored scratch):"
    echo "  git clone --depth 1 https://github.com/Hologram-Technologies/holospaces $CLONE"
    exit 127
fi
command -v cargo >/dev/null 2>&1 || { echo "cargo absent (expected in the holospaces devcontainer)"; exit 127; }

echo "── CC-9 fast tier: emulator passes the official riscv-tests + boots a κ-disk guest ──"
cargo test --manifest-path "$CLONE/Cargo.toml" -p holospaces --test cc9_emulator -- --nocapture \
    > vv/witness/cc9-emulator.log 2>&1; echo "  CC9_EXIT=$? · vv/witness/cc9-emulator.log"

echo "── Build the in-browser emulator codemodule for wasm32 ──"
cargo build --manifest-path "$CLONE/crates/holospaces-emulator/Cargo.toml" --target wasm32-unknown-unknown \
    > vv/witness/emulator-wasm32.log 2>&1; echo "  EMU_WASM_EXIT=$? · vv/witness/emulator-wasm32.log"

echo "── (heavy, optional) CC-9 real-Linux→userspace + CC-33 OCI-boot+ingress ──"
echo "   run: $CLONE/vv/suites/cc9-emulator.sh ; $CLONE/vv/suites/cc33-guest-bridge.sh"
echo "✓ substrate authorities recorded under vv/witness/"
