@native-convergence
Feature: HL-6 — native convergence witness (the Hermes guest boots, serves, and resumes)
  The cc_hermes_guest witness boots the linux/riscv64 Hermes image on the holospaces RISC-V emulator —
  the same instruction-interpreter the browser runs via wasm — serves /api/status over the in-process
  loopback bridge, banks the warm machine as a content-addressed κ, and resumes it byte-identically.
  GREEN once the on-demand witness has run (it records vv/witness/hermes-guest-witness.json and
  hermes-resume-witness.json); RED — non-gating — before then. The interpreted full boot is ~24 min, so
  it is run on demand (tools/holo/witness/run-hermes-guest.sh), not in the CI gate.

  Scenario: the linux/riscv64 Hermes runtime image is built
    Given the linux/riscv64 Hermes OCI image is built

  Scenario: the guest boots Hermes and serves /api/status over the loopback bridge
    Given the native convergence witness has run
    Then the in-guest dashboard reached READY
    And it served a non-empty /api/status over the loopback bridge

  Scenario: the warm dashboard snapshots and resumes byte-identically
    Given the native convergence witness has run
    Then the warm machine round-trips to the same content-address κ
    And the banked κ resumes in a fresh process to a byte-identical machine with no re-boot
