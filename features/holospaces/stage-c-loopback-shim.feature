Feature: Stage C — the RISC-V loopback boot shim (HL-4)
  The single holospaces-web change HL-C needs: a RISC-V boot fn combining routed egress + an OPFS-paged
  κ-disk + the in-process loopback ingress bridge (the AArch64 boot_devcontainer_opfs_full already does
  this; the RISC-V routed_opfs path lacked only enable_loopback). It is authored and carried in-repo as
  a patch against holospaces-web, and compiles for wasm32 (recorded in docs/holospaces/conformance.md).
  This makes the dashboard→guest ingress combination realizable; the remaining work (a live round-trip
  against a booted guest) stays the HL-C target.

  Scenario: the loopback boot shim is carried as an in-repo patch against holospaces-web
    Given the holospaces-web loopback shim patch
    Then it adds the boot fn "boot_devcontainer_routed_opfs_streamed_bridged"
    And it enables the loopback ingress bridge
    And it composes routed egress with an OPFS-paged disk
    And it is modeled on the existing routed-OPFS-streamed boot path
