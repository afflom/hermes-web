#!/usr/bin/env bash
# build-app.sh — build the Hermes dashboard as a holospace app object and seal it.
#
# Stages (documentation-as-code: this script IS the Stage-A build contract):
#   1. Vite-build web/ with HERMES_HOLO_BASE=./ so every asset ref is relative
#      and resolves into the sealed κ-closure when mounted at ./apps/hermes/.
#   2. Place the built bundle under apps/hermes/, preserving the source-of-truth
#      inputs (holospace.json, icon.svg) and the lock (relock rewrites it).
#   3. Seal: FRAME=holo APPS=apps node tools/holo/relock.mjs hermes.
#
# Idempotent. Requires the vendored frame at holo/ (git submodule) and web deps
# installed (npm ci in web/).
#
#   tools/holo/build-app.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
APP_ID="hermes"
WEB="$ROOT/web"
OUT="$WEB/dist-holo"
DEST="$ROOT/apps/$APP_ID"

echo "▸ 1/3 building web/ (HERMES_HOLO_BASE=./)"
( cd "$WEB" && HERMES_HOLO_BASE=./ npx vite build --outDir "$OUT" --emptyOutDir )

echo "▸ 2/3 placing bundle under apps/$APP_ID/ (preserving holospace.json, icon.svg)"
# Remove previously-emitted bundle files, keep the source-of-truth inputs + lock.
find "$DEST" -mindepth 1 -maxdepth 1 \
  ! -name holospace.json \
  ! -name icon.svg \
  ! -name holospace.lock.json \
  -exec rm -rf {} +
cp -R "$OUT"/. "$DEST"/
# Vite may emit its own favicon/index assets; the holospace inputs are canonical.

echo "▸ 3/3 sealing apps/$APP_ID/holospace.lock.json"
( cd "$ROOT" && FRAME=holo APPS=apps node tools/holo/relock.mjs "$APP_ID" )

echo "✓ build-app: apps/$APP_ID sealed"
