#!/usr/bin/env bash
# finalize-warm.sh — after the cold-boot re-bank writes vv/witness/hermes-warm.kappa (warm, comprehensively
# warmed, PRE-SETTLED, on a 1.5 GiB writable disk), publish it and verify the deployed instance is fully
# functional: chunk → vendor wasm-free CAS → build dist-pages → run the comprehensive feature BDD + the
# agent capability suite against the real in-browser backend. Fails loudly if any feature regresses.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
KAPPA="vv/witness/hermes-warm.kappa"

[ -f "$KAPPA" ] || { echo "finalize: no $KAPPA — re-bank first"; exit 1; }
echo "=== 1) chunk the warm κ → web/public/holo/warm ==="
node tools/holo/chunk-warm-kappa.mjs "$KAPPA" web/public/holo/warm || exit 1

echo "=== 2) build dist-pages (hologram) ==="
( cd web && HERMES_HOLO_BASE=/hermes-web/ npx vite build --outDir dist-pages --emptyOutDir ) || exit 1
cp web/dist-pages/index.html web/dist-pages/404.html

echo "=== 3) comprehensive feature BDD (all 18 features over the live backend) ==="
( cd e2e && E2E_EXPECT_HOLOGRAM=1 E2E_TIMEOUT=480 ./run.sh tests/features.spec.ts )
FEAT=$?
echo "=== 4) agent capability suite ==="
( cd e2e && E2E_EXPECT_HOLOGRAM=1 E2E_TIMEOUT=480 ./run.sh tests/agent-capability.spec.ts )
CAP=$?

echo "=== finalize summary ==="
echo "features.spec exit=$FEAT   agent-capability exit=$CAP"
[ "$FEAT" = 0 ] && [ "$CAP" = 0 ] && echo "✓ deployed instance fully functional" || echo "✗ a feature regressed — see logs"
exit $(( FEAT || CAP ))
