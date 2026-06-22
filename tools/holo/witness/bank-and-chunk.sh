#!/usr/bin/env bash
# bank-and-chunk.sh — the unattended back half of the holospaces pipeline. Waits for the riscv64 Hermes
# image build to finish, boots the guest under the emulator and banks the warm κ (the boot witness), then
# slices it into the content-addressed CAS the browser resumes from. Designed to run as one long
# background task: image-build → boot → bank κ → chunk → manifest.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
LOG=vv/witness/bank-and-chunk.log
exec > >(tee -a "$LOG") 2>&1
echo "▸ bank-and-chunk starting $(date -u +%FT%TZ)"

# 1) Wait for the image build to produce the OCI layout (build-guest-image.sh extracts it last).
echo "▸ waiting for the riscv64 Hermes image build…"
for _ in $(seq 1 480); do            # up to ~4h at 30s cadence
  [ -f vv/witness/hermes-riscv64-oci/index.json ] && break
  if ! pgrep -f "buildx build.*Dockerfile.riscv64" >/dev/null 2>&1 \
     && ! pgrep -f build-guest-image.sh >/dev/null 2>&1 \
     && [ ! -f vv/witness/hermes-riscv64-oci/index.json ]; then
    echo "✗ image build process exited without producing the OCI layout — see vv/witness/build-guest-image.log"
    tail -30 vv/witness/build-guest-image.log 2>/dev/null
    exit 1
  fi
  sleep 30
done
[ -f vv/witness/hermes-riscv64-oci/index.json ] || { echo "✗ timed out waiting for the image"; exit 1; }
echo "✓ image built: vv/witness/hermes-riscv64-oci"

# 2) Boot the guest under the emulator + bank the warm κ (HL-B/HL-C/HL-6 witness).
echo "▸ booting the guest + banking the warm κ (this includes the one-time interpreted boot)…"
bash tools/holo/witness/run-hermes-guest.sh
[ -f vv/witness/hermes-warm.kappa ] || { echo "✗ no warm κ banked — see vv/witness/hermes-guest.log"; exit 1; }
echo "✓ warm κ banked: $(stat -c%s vv/witness/hermes-warm.kappa) bytes"

# 3) Slice the warm κ into the content-addressed CAS the browser resumes from (records the substrate κ).
echo "▸ chunking the warm κ into the shippable CAS…"
node tools/holo/chunk-warm-kappa.mjs
echo "✓ bank-and-chunk complete $(date -u +%FT%TZ)"
