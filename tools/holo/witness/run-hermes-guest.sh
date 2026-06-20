#!/usr/bin/env bash
# run-hermes-guest.sh — the HL-B / HL-C convergence witness: boot the Hermes linux/riscv64 guest under
# the holospaces emulator and reach its in-guest web_server.py over the in-process loopback bridge.
# Places the carried witness (cc_hermes_guest.rs) into the holospaces checkout and runs it.
#
# Prereqs (all satisfiable in the shared devcontainer):
#   - the holospaces clone at .holo-ref/holospaces (gitignored scratch)
#   - the Hermes image built: tools/holo/build-guest-image.sh  (→ vv/witness/hermes-riscv64-oci/)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
CLONE=".holo-ref/holospaces"
[ -f "$CLONE/Cargo.toml" ] || { echo "holospaces clone absent at $CLONE"; exit 127; }
[ -f "vv/witness/hermes-riscv64-oci/index.json" ] || { echo "Hermes image not built — run tools/holo/build-guest-image.sh"; exit 127; }
command -v cargo >/dev/null 2>&1 || { echo "cargo absent"; exit 127; }

cp tools/holo/witness/cc_hermes_guest.rs "$CLONE/crates/holospaces/tests/cc_hermes_guest.rs"
mkdir -p vv/witness
cargo test --manifest-path "$CLONE/Cargo.toml" -p holospaces --release \
  --test cc_hermes_guest -- --ignored --nocapture 2>&1 | tee vv/witness/hermes-guest.log
echo "HERMES_GUEST_EXIT=${PIPESTATUS[0]}" | tee -a vv/witness/hermes-guest.log
