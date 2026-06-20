# vv/ — Verification & Validation for the Hermes holospace lift

The **executable V&V framework** for lifting the `hermes-web` dashboard onto the os-holo / holospaces
substrate. It follows the [holospaces V&V model](https://github.com/Hologram-Technologies/holospaces)
(this repo shares its devcontainer): every witness evaluates a component against an **external
authority — never against itself** — and the unfinished work is specified **behaviour-first** as
expected-RED targets.

- **Runner:** `./run.sh` is the single entry point (also `just vv`).
- **Provenance:** [PROVENANCE.md](PROVENANCE.md) records each external authority, its pin, and how it
  is verified.
- **Catalog:** [docs/holospaces/conformance.md](../docs/holospaces/conformance.md) — the HL-* criteria
  (the analog of holospaces' arc42 ch.10 Conformance catalog).
- **Witness implementation:** each suite/target is a thin shell wrapper over a Gherkin feature run by
  the dependency-free strict runner [`tools/holo/bdd.mjs`](../tools/holo/bdd.mjs) — the analog of a
  holospaces suite wrapping `cargo test --test ccN`.

## Tiers (identical semantics to holospaces)

- **Suites (`vv/suites/*.sh`) — component conformance. GREEN. GATING.** Each witnesses one implemented
  component against its external authority. A failure fails V&V (`run.sh` exits 1) and blocks deploy.
  - `hl1-app-object` — the dashboard seals as an app object + folds into the frame (authority: os-holo
    κ primitives, re-derivation/Law L5).
  - `hl2-hologram-wire` — the transport's HTTP/1.1 + RFC-6455 bytes (authority: the standards + their
    canonical vectors).
  - `hl3-transport-seam` — a single swappable transport chokepoint (authority: the source tree).

- **Targets (`vv/targets/*.sh`) — behaviour-driven, written-first, EXPECTED-RED, NON-GATING.** Each is
  the executable spec for unfinished work; it is *meant* to be red until the component is built to it,
  and it never fails V&V or blocks deploy. A GREEN target is the signal to **promote** it into
  `suites/` (move the script, drop the `@pending`/`@stage-*` from the feature).
  - `hl-stage-b-guest` — Python Hermes boots in the in-browser RISC-V guest, state on the OPFS κ-store.
  - `hl-stage-c-live` — the hologram transport reaches the *real* in-guest `web_server.py`.
  - `hl-stage-d-convergence` — the full learning loop end to end, surviving a tab reload.

**To see what is left to build, read the targets** (they are red by design) and the catalog rows marked
*target*. A component is "complete" only when its HL-* row is witnessed by a green suite.

## Running

```
just vv          # or: vv/run.sh
```

Runs fully inside the shared devcontainer with no extra setup (Node for the runner; the suites need only
the vendored frame at `holo/` and the web build for HL-1). Witness JSON is written under
`vv/witness/` (gitignored). The Pages deploy ([.github/workflows/holospaces-pages.yml](../.github/workflows/holospaces-pages.yml))
runs the suites tier as a fail-closed gate; targets are reported but never block.

## Promotion workflow (when a target goes green)

1. Build the component until its target script exits 0 (`TARGET MET` in `run.sh`).
2. `git mv vv/targets/hl-stage-X.sh vv/suites/`, drop the `--targets` flag, point it at the now-green
   scenarios.
3. Remove the `@pending`/`@stage-X` tags from the feature so the suite runs it strict.
4. Turn the catalog row `live`.
