#!/usr/bin/env bash
# HL-2 — the hologram transport speaks correct HTTP/1.1 + RFC-6455 over the loopback byte stream.
# Authority: the HTTP/1.1 + WebSocket (RFC 6455) standards and their canonical vectors (SHA-1 KAT, the
# RFC-6455 Sec-WebSocket-Accept example), exercised against a mock in-guest web_server.
# Witness: features/holospaces/stage-c-hologram-wire.feature (run by tools/holo/bdd.mjs).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node tools/holo/bdd.mjs features/holospaces/stage-c-hologram-wire.feature \
  --witness vv/witness/hl2-hologram-wire.json
