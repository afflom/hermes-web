#!/usr/bin/env bash
# build-guest-image.sh — build the Hermes linux/riscv64 guest OCI image (Stage B / HL-B) and export an
# OCI layout the holospaces κ-disk ingests (the same path CC-10/CC-33 boot). Requires docker buildx +
# riscv64 binfmt:  docker run --privileged --rm tonistiigi/binfmt --install riscv64
#
#   tools/holo/build-guest-image.sh [out-basename]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-vv/witness/hermes-riscv64-oci}"
mkdir -p "$(dirname "$OUT")"
command -v docker >/dev/null 2>&1 || { echo "docker absent"; exit 127; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx absent"; exit 127; }

echo "▸ building linux/riscv64 Hermes guest image (OCI layout → ${OUT}.tar)"
docker buildx build --platform linux/riscv64 \
  -f docker/holo/Dockerfile.riscv64 \
  --output "type=oci,dest=${OUT}.tar" \
  "$ROOT"

# Extract the OCI tar into a layout dir (oci-layout + index.json + blobs/) the holospaces ingest reads
# (the same shape as vv/artifacts/cc21/image/), which the HL-B/HL-C witness boots.
rm -rf "$OUT" && mkdir -p "$OUT" && tar -xf "${OUT}.tar" -C "$OUT"
echo "✓ wrote ${OUT}.tar + extracted layout → ${OUT}/ — boot it: tools/holo/witness/run-hermes-guest.sh"
