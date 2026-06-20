# Justfile — task entry points for the Hermes holospace lift.
# Mirrors holospaces' `just vv` so the V&V runs identically in the shared devcontainer.

# Run the full V&V: suites (gating, green) + targets (non-gating, expected-RED).
vv:
    vv/run.sh

# Build the dashboard as a sealed holospace app object (Vite base=./ → place → relock).
holo-build:
    tools/holo/build-app.sh

# Assemble the GitHub Pages _site: fold the sealed app into the vendored frame.
holo-assemble:
    FRAME=holo APPS=apps OUT=_site node tools/holo/assemble-site.mjs hermes

# Run the behaviour suite directly (all features; @pinned included).
holo-test:
    node tools/holo/bdd.mjs features/holospaces

# Cross-repo toolchain proof: run holospaces' own CC-1 conformance in this devcontainer.
cc1:
    tools/holo/record-cc1.sh

# Full local pipeline: build → assemble → V&V.
holo-all: holo-build holo-assemble vv
