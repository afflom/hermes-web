#!/usr/bin/env bash
# build-guest-image-slim.sh — assemble the SLIM Hermes guest image WITHOUT recompiling any wheels, by
# copying the already-built riscv64 site-packages out of the fat image (docker/holo/Dockerfile.riscv64).
# The fat image is passed as a buildx `oci-layout` build context, so cryptography/Pillow/etc. are reused,
# not rebuilt. Produces an image small enough for the witness's in-memory ext4 assembly.
#
# Prereq: the fat image built once (tools/holo/build-guest-image.sh) and preserved as an OCI layout at
# vv/witness/hermes-fat-oci/ (oci-layout + index.json + blobs/).
#
#   tools/holo/build-guest-image-slim.sh [out-basename]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-vv/witness/hermes-riscv64-oci}"
FAT="vv/witness/hermes-fat-oci"
[ -f "$FAT/index.json" ] || { echo "fat image layout absent at $FAT — build it: tools/holo/build-guest-image.sh, then cp -r the layout to $FAT"; exit 127; }

# The single linux/riscv64 manifest digest in the fat layout (the build context reference).
DIGEST="$(python3 -c "import json;print(json.load(open('$FAT/index.json'))['manifests'][0]['digest'])")"
echo "▸ slim build from fat image $DIGEST (no recompile)"
docker buildx build --platform linux/riscv64 \
  --build-context "fat=oci-layout://$ROOT/$FAT@$DIGEST" \
  -f docker/holo/Dockerfile.riscv64.slim \
  --output "type=oci,dest=${OUT}.tar" "$ROOT"

rm -rf "$OUT" && mkdir -p "$OUT" && tar -xf "${OUT}.tar" -C "$OUT"
echo "✓ slim image → ${OUT}.tar ($(du -h "${OUT}.tar" | cut -f1)) + extracted layout → ${OUT}/"
echo "  boot it: tools/holo/witness/run-hermes-guest.sh"
