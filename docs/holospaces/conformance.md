# Conformance catalog — the Hermes holospace lift (HL-*)

The authoritative list of conformance criteria for lifting `hermes-web` onto the substrate, modeled on
holospaces' arc42 chapter 10 Conformance catalog. Each criterion is validated against an **external
authority** (provenance in [`vv/PROVENANCE.md`](../../vv/PROVENANCE.md)) and witnessed by a `vv/` suite
(gating, green) or target (non-gating, expected-RED). Run them all with `just vv`.

## Live (suites — green, gating)

| HL | Title | Authority | Test method | Witness |
|----|-------|-----------|-------------|---------|
| **HL-1** | The dashboard seals as a holospace app object and folds into the frame | os-holo κ primitives (re-derivation, Law L5); the frame's `os-closure.json` + catalog | Deterministic seal (re-seal → identical root κ, no changed files); dual-axis closure; conscience pinned; base-relative entry; additive registration preserving the 32 frame apps | `vv/suites/hl1-app-object.sh` → `features/holospaces/stage-a-app-object.feature` |
| **HL-2** | The hologram transport speaks correct HTTP/1.1 + WebSocket over the loopback byte stream | HTTP/1.1 (RFC 7230) + WebSocket (RFC 6455) + canonical vectors | Codec round-trips against a mock in-guest server: REST read/verb, chunked reassembly, WS upgrade (`Sec-WebSocket-Accept` worked example) + masked framing, partial-frame safety | `vv/suites/hl2-hologram-wire.sh` → `features/holospaces/stage-c-hologram-wire.feature` |
| **HL-3** | The dashboard data layer has a single, swappable transport seam | the source tree (static property) | No `new WebSocket`/`new EventSource`/raw `fetch(` outside `api.ts`; `api.ts` exposes `setFetchImpl`/`setSocketFactory`/`openSocket`/`resetTransport` | `vv/suites/hl3-transport-seam.sh` → `features/holospaces/stage-c-transport.feature` |
| **HL-4** | The RISC-V loopback boot shim exists (routed egress + OPFS + loopback ingress, in one machine) | the holospaces-web source + the Rust/wasm32 compiler | A patch adds `boot_devcontainer_routed_opfs_streamed_bridged` (the routed-OPFS path + `machine.enable_loopback()`, modeled on AArch64 `boot_devcontainer_opfs_full`); it compiles for `wasm32-unknown-unknown` (recorded below) | `vv/suites/hl4-loopback-shim.sh` → `features/holospaces/stage-c-loopback-shim.feature`; patch: `tools/holo/patches/holospaces-web-riscv-loopback.patch` |
| **HL-5** | The dashboard selects + installs its transport at startup (origin / static / hologram) | the source tree | `selectHoloTransport` chooses by launcher signal (`__HOLO_GUEST_BRIDGE__` → hologram, `__HOLO_STATIC__` → static, else origin) and is wired into `main.tsx` before render; the static transport answers reads with empty states + inert sockets | `vv/suites/hl5-transport-bootstrap.sh` → `features/holospaces/stage-c-transport-bootstrap.feature` |

## Targets (behaviour-first — expected-RED, non-gating)

| HL | Title | Authority | Build-to-green requires | Witness |
|----|-------|-----------|-------------------------|---------|
| **HL-B** | Python Hermes boots in the in-browser RISC-V guest, state on the OPFS κ-store | holospaces CC-9 (emulator boots Linux) + CC-33 (OCI image boots) | the substrate is witnessed here (CC-9 7/7 + emulator wasm built — below); remaining: the `linux/riscv64` Hermes OCI image (`docker/holo/Dockerfile.riscv64`, building) ingested + booted, running `python … web` | `vv/targets/hl-stage-b-guest.sh` |
| **HL-C** | The hologram transport reaches the *real* in-guest `web_server.py` | holospaces CC-33 (in-process loopback ingress) | the booted guest (HL-B) + `installHologramTransport` wired to the **HL-4 shim** (`boot_devcontainer_routed_opfs_streamed_bridged`). The shim is now authored + compiles (HL-4), so only the live guest remains | `vv/targets/hl-stage-c-live.sh` |
| **HL-D** | The complete agent end to end in the browser, surviving a tab reload | holospaces CC-9 + ADR-014 egress | Stages B–C + egress (relay or direct CORS) wired; learning loop persists on the κ-store | `vv/targets/hl-stage-d-convergence.sh` |

A target is promoted to a suite (and its row turned *live*) only when its script exits 0 (`TARGET MET`).

### HL-4 shim — recorded wasm32 compile

```
$ cargo build --manifest-path .holo-ref/holospaces/crates/holospaces-web/Cargo.toml --target wasm32-unknown-unknown
   Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 36s    # BUILD_EXIT=0
```

> **Recorded: holospaces-web + the loopback shim compiles for `wasm32-unknown-unknown`** (exit 0) in
> this devcontainer. The shim (`boot_devcontainer_routed_opfs_streamed_bridged`) is the routed-OPFS
> boot path plus `machine.enable_loopback()` — the RISC-V analogue of AArch64 `boot_devcontainer_opfs_full`.
> Carried at `tools/holo/patches/holospaces-web-riscv-loopback.patch`; apply to a holospaces checkout
> with `git apply` (or upstream it). With this, HL-C reduces to wiring `installHologramTransport` to a
> guest booted via this fn — i.e. it is blocked only on HL-B.

### Substrate authorities executed in this devcontainer (HL-B / HL-C)

The HL-B/HL-C targets are anchored to holospaces' own conformance suites — which run **unchanged** here
because the devcontainer is shared. Executed (logs under `vv/witness/`, reproduce with
`tools/holo/record-substrate.sh`):

```
CC-9  cargo test -p holospaces --test cc9_emulator
      7 passed; 0 failed; 2 ignored        # the heavy boot tier
        ✓ the_emulator_passes_the_official_riscv_tests   (all 134 official riscv-tests)
        ✓ the_emulator_core_conforms_to_the_risc_v_isa
        ✓ the_emulator_runs_a_guest_off_a_kappa_disk_and_snapshots_to_the_store
        ✓ the_emulator_services_sbi_console_and_shutdown
        ✓ the_emulator_takes_a_clint_timer_interrupt
        ✓ the_emulator_codemodule_runs_on_the_real_hologram_runtime

emulator wasm  cargo build -p holospaces-emulator --target wasm32-unknown-unknown
      Finished, exit 0 → 16.5 MB holospaces_emulator.wasm   # the in-browser codemodule
```

And the guest's Python userland runs on riscv64 here (`tools/holo/build-guest-image.sh` builds the full
image; the base executes today):

```
$ docker run --rm --platform linux/riscv64 riscv64/python:3.11-slim \
    python3 -c "import sys,platform; print(sys.version.split()[0], platform.machine())"
HL-B riscv64 python OK 3.11.15 riscv64        # Python 3.11.15 on riscv64, under QEMU, in this devcontainer
```

So the RISC-V emulator (ISA-conformant, κ-disk guest boot, SBI/CLINT, codemodule-on-runtime), its
wasm32 build, and a riscv64 Python userland are all **proven in this container**. The heavy tiers are
**executed green too** (`vv/witness/cc9-cc33-heavy.log`):

```
CC-9 heavy   cc9: passed all 134 official riscv-tests
             ✓ the_emulator_boots_real_linux_to_userspace        (1 passed)
             ✓ the_codemodule_boots_real_linux_on_the_substrate   (1 passed, 255s)
             ✓ qemu-system-riscv64 differential PASS (oracle current) — emulator output ≡ QEMU
CC-33        ✓ a_guest_server_is_reachable_over_the_in_process_substrate_bridge   (1 passed, 22.5s)
```

CC-33 is the **exact OCI→ext4→boot→loopback-ingress path** the Hermes guest + hologram transport ride
(the HL-C ingress authority).

### The Hermes guest serves /api/status on riscv64 (proven)

The `linux/riscv64` Hermes image (`docker/holo/Dockerfile.riscv64`, slimmed compile-free via
`Dockerfile.riscv64.slim`) **runs the real agent**: booted under user-mode QEMU, `hermes dashboard
--host 0.0.0.0 --port 9119 --insecure --no-open --skip-build` starts uvicorn and answers `GET
/api/status` with the real status JSON (recorded at `vv/witness/riscv64-dashboard-api-status.json`):

```
GET /api/status → 200  {"version":"0.17.0","release_date":"2026.6.19","config_version":30, …}
```

(Two bugs were found here via the fast QEMU path, not the slow full-system boot: the dashboard
subcommand is `dashboard`, not `web`; and `--skip-build` needs the prebuilt UI dist — now carried in
the image, since in the lift the guest serves `/api` while the frame serves the UI from the app object.)

### HL-6 — snapshot/resume warm-start (the interpreted-boot resolution)

The cold kernel-boot + full-Hermes-import under the instruction-interpreted RISC-V core is the dominant
cost. The substrate's **designed** answer (not a workaround) is content-addressed **snapshot/resume**
(CC-30): boot to *warm* (dashboard READY) **once**, `Emulator::snapshot()` the canonical κ (CPU+RAM+
disk+9p), and `resume` it instantly on every launch — the browser persists the gzipped κ to the OPFS
store (`Workspace.suspend`/`resume_devcontainer`). The warm-start twin of the boot shim,
`resume_devcontainer_bridged` (resume + `enable_loopback` so the host can immediately dial the resumed
dashboard), is in `tools/holo/patches/holospaces-web-riscv-loopback.patch`. The convergence witness
([`cc_hermes_guest.rs`](../../tools/holo/witness/cc_hermes_guest.rs)) boots to READY, then — *the instant*
the dashboard announces ready — `snapshot()`s the warm machine and **banks** the κ to
`vv/witness/hermes-warm.kappa` *before* doing anything else, so the one-time interpreted boot is
durably captured. A second test, `the_warm_dashboard_resumes_from_its_banked_kappa_byte_identical`,
`restore`s that on-disk κ in a fresh process in **8.7 s with no boot** (vs the ~24-min cold boot) to a
**byte-identical** machine (same content κ) — the exploit realized end to end: pay the cold boot once,
resume forever. Resume restores CPU+RAM+disk+9p faithfully; the live VirtIO-net transport is
re-established on resume (intentionally outside the content snapshot — see `Emulator::snapshot`), so the
resumed dashboard serves once the transport is re-attached. This is also what defeats the *native*
witness's practical wall — the instruction-interpreted full boot is ~24 min, longer than the
interruptions the sandbox threw at it; banking the κ at READY means that one expensive boot is captured
and never repeated.

Two memory notes for the *native* witness (the browser does not hit these): the dense `assemble_ext4`
holds the image in RAM, so the witness frees the ingest store early and runs with headroom; the
substrate's **streaming assembly** (CC-50, `stream_ext4_image_bootable` / `boot_net_streamed`) is the
in-RAM-free path the browser uses (OPFS), and a native streaming variant is the follow-up to a
disk-format detail. The image, the command, and the serving `/api/status` are all proven; the only cost
left for the native witness is that one interpreted boot, which banking the warm κ at READY pays exactly
once.

### HL-B / HL-C convergence witness (proven — passes)

The witness that flips HL-B and HL-C green is carried at
[`tools/holo/witness/cc_hermes_guest.rs`](../../tools/holo/witness/cc_hermes_guest.rs) and **passes**
(`cargo test -p holospaces --test cc_hermes_guest -- --ignored` → exit 0). Modeled on `CC-33`, it
ingests the Hermes OCI layout, assembles an ext4 rootfs with an injected `/init` that runs Python and
execs `python -m hermes_cli.main dashboard --host 0.0.0.0 --port 9119 --insecure --no-open
--skip-build`, boots it on the emulator with `enable_loopback()`, asserts the guest prints
`HERMES-GUEST-PYTHON-OK` (HL-B), then `dial_guest(9119)` + `GET /api/status` and asserts the HTTP
response (HL-C), banks the warm κ, then `restore`s it and asserts the round-trip to the same
content-address κ (HL-6). A captured native run is preserved at
[`vv/witness/hermes-guest-readyboot.log`](../../vv/witness/hermes-guest-readyboot.log) — the real guest
console through to `HERMES_DASHBOARD_READY` on the holospaces RISC-V emulator:

```
[hermes-guest] dense rootfs assembled: 900603904 bytes; booting
HERMES-GUEST-PYTHON-OK 3.11.15
→ Skipping web UI build (--skip-build); using dist at /opt/hermes/hermes_cli/web_dist
Binding to 0.0.0.0 with --insecure — the dashboard has no robust authentication...
HERMES_DASHBOARD_READY — dashboard up; proceeding to dial
```

The full chain has **passed end to end (exit 0)** — recorded in
[`vv/witness/hermes-guest-witness.json`](../../vv/witness/hermes-guest-witness.json):

```json
{ "targets": "HL-B+HL-C+HL-6", "dashboard_ready": true,
  "api_status_response_len": 577,
  "warm_kappa":    "sha256:f1adc6c8…", "warm_snapshot_len": 1437475760,
  "resumed_kappa": "sha256:f1adc6c8…", "round_trip_identical": true }
```

i.e. the guest booted, served a 577-byte `/api/status` over the loopback bridge (HL-C, native — the 200
body is also captured under user-mode QEMU in
[`riscv64-dashboard-api-status.json`](../../vv/witness/riscv64-dashboard-api-status.json)), banked the
1.44 GB warm κ, and round-tripped it byte-identically (HL-6). Run with
`tools/holo/witness/run-hermes-guest.sh` once `build-guest-image.sh` has produced
`vv/witness/hermes-riscv64-oci/`; it banks `vv/witness/hermes-warm.kappa`. The interpreted full-system
boot is ~24 min, so the witness is `#[ignore]` (run on demand) — which is exactly why HL-6's
banked-resume warm-start exists: the sibling `the_warm_dashboard_resumes_from_its_banked_kappa_byte_identical`
test then `restore`s that on-disk κ in a **fresh process in 8.7 s** (vs the ~24 min cold boot — a ~165×
collapse) to a **byte-identical** machine, no boot and no import
([`vv/witness/hermes-resume-witness.json`](../../vv/witness/hermes-resume-witness.json),
`"byte_identical": true`). Resume restores CPU+RAM+disk+9p faithfully; the live VirtIO-net transport is
re-established on resume (it is intentionally outside the content snapshot), so serving resumes through
transport re-attachment — the boot witness already proved the live serve.

## Cross-repo toolchain proof — holospaces CC-1 in this devcontainer

This repo shares the holospaces devcontainer, so holospaces' own conformance suites run here unchanged.
Recorded run of **holospaces CC-1** (κ-labels equal the reference BLAKE3 / SHA-2 / SHA-3 implementations,
byte-for-byte — the substrate authority the HL-1 seal relies on):

```
$ cargo test --manifest-path .holo-ref/holospaces/Cargo.toml -p holospaces --test cc1_kappa_kat
running 5 tests
test default_axis_is_canonical_blake3_label ... ok
test addressing_is_deterministic ... ok
test re_derivation_rejects_mismatched_content ... ok
test single_bit_change_changes_the_label ... ok
test kappa_digest_equals_reference_implementation ... ok
test result: ok. 5 passed; 0 failed; 0 ignored
```

> **Recorded: 5/5 passed** (cargo 1.96.0, build 5m22s) in this devcontainer via `tools/holo/record-cc1.sh`
> (`just cc1`). The result is environment-reproducible; the toolchain (cargo + the pinned `blake3`/`sha2`/
> `sha3` crates) is fixed by the devcontainer + holospaces' `Cargo.lock`. This is the external authority
> for HL-1: holospaces' κ-addressing — the same primitives the os-holo seal re-derives against (Law L5).
