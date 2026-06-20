#!/usr/bin/env bash
#
# vv/run.sh — the Hermes-holospace-lift V&V runner (single entry point; also `just vv`).
#
# Mirrors holospaces' vv/run.sh tiers, applied to THIS fork's lift of the hermes-web dashboard onto the
# os-holo / holospaces substrate. Each witness is executed against an EXTERNAL authority, never against
# itself (provenance in vv/PROVENANCE.md): the seal re-derives against the vendored os-holo κ
# primitives (Law L5); the wire codec is checked against the RFC-6455 / HTTP/1.1 standards and their
# canonical vectors; the ingress contract is anchored to holospaces CC-33.
#
# Tiers (identical semantics to holospaces):
#   SUITES  (vv/suites/*.sh)  — component conformance, GREEN, GATING. A failure fails V&V (exit 1).
#   TARGETS (vv/targets/*.sh) — behaviour-driven, written-first, EXPECTED-RED, NON-GATING. A RED target
#                               never fails V&V; a GREEN target is the signal to PROMOTE it into suites/.
#
# The witnesses are implemented as Gherkin features (features/holospaces/*.feature) run by the
# dependency-free strict runner tools/holo/bdd.mjs — the analog of holospaces' suites wrapping
# `cargo test`. Run fully inside the shared devcontainer with no extra setup.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "═══ Hermes-holospace-lift V&V ═══"
echo

# ── SUITES — component conformance (GREEN, GATING) ──────────────────────────────────────────────
echo "── Suites (component conformance vs external authority — gating) ──"
cc_rc=0
witnessed=""
for suite in "$ROOT"/vv/suites/*.sh; do
    [ -e "$suite" ] || continue
    name="$(basename "$suite" .sh)"
    echo "  • $name"
    if "$suite" >/dev/null 2>&1; then
        witnessed="$witnessed ${name%%-*}"
    else
        echo "    FAILED ($name) — re-run: $suite"
        cc_rc=1
    fi
done
[ -n "$witnessed" ] || witnessed=" (none)"
echo

# ── TARGETS — behaviour-driven, expected-RED, NON-GATING ────────────────────────────────────────
echo "── Targets (behavioural spec first; expected RED until built — non-gating) ──"
target_met=""
target_red=""
if [ -d "$ROOT/vv/targets" ]; then
    for suite in "$ROOT"/vv/targets/*.sh; do
        [ -e "$suite" ] || continue
        name="$(basename "$suite" .sh)"
        if "$suite" >/dev/null 2>&1; then
            echo "  ⚑ $name — TARGET MET; promote → vv/suites/ (the capability is now live)"
            target_met="$target_met ${name}"
        else
            echo "  • $name — RED (target; build the component to this spec)"
            target_red="$target_red ${name}"
        fi
    done
fi
echo

# ── Summary ─────────────────────────────────────────────────────────────────────────────────────
echo "── Summary ──"
echo "  witnessed (gating, green):$witnessed"
echo "  targets MET (promote):${target_met:- (none)}"
echo "  targets RED (unfinished):${target_red:- (none)}"
echo
if [ "$cc_rc" -eq 0 ]; then echo "✓ V&V PASS — all suites green (targets are non-gating)"; else echo "✗ V&V FAIL — a gating suite is red"; fi
exit "$cc_rc"
