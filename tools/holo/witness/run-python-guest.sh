#!/usr/bin/env bash
# run-python-guest.sh — HL-B/HL-C MECHANISM witness: boot CPython in the riscv64 guest under the
# emulator and reach an in-guest Python server over the in-process loopback bridge. Uses the
# riscv64/python base image (fast to export) to isolate the convergence mechanism from the full Hermes
# image. Runs fully in the shared devcontainer.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
CLONE=".holo-ref/holospaces"
[ -f "$CLONE/Cargo.toml" ] || { echo "holospaces clone absent at $CLONE"; exit 127; }
command -v docker >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1 || { echo "need docker + cargo"; exit 127; }
mkdir -p vv/witness

# Export the base python image as an OCI layout the witness ingests (the base is cached; this is quick).
if [ ! -f vv/witness/python-riscv64-oci/index.json ]; then
    printf 'FROM riscv64/python:3.11-slim\n' | docker buildx build --platform linux/riscv64 \
        --output type=oci,dest=vv/witness/python-riscv64-oci.tar -f - .
    rm -rf vv/witness/python-riscv64-oci && mkdir -p vv/witness/python-riscv64-oci
    tar -xf vv/witness/python-riscv64-oci.tar -C vv/witness/python-riscv64-oci
fi

cp tools/holo/witness/cc_python_guest.rs "$CLONE/crates/holospaces/tests/cc_python_guest.rs"
cargo test --manifest-path "$CLONE/Cargo.toml" -p holospaces --release \
    --test cc_python_guest -- --ignored --nocapture 2>&1 | tee vv/witness/python-guest.log
echo "PY_GUEST_EXIT=${PIPESTATUS[0]}" | tee -a vv/witness/python-guest.log
