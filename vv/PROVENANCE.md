# vv/ — Provenance of external authorities

Every witness in this V&V framework validates the lift against an **external, authoritative** standard
or oracle — never against itself (the holospaces rule). This file records *what* each authority is,
*from where*, at *which pin*, and *how it is verified*.

| HL | Authority | Source / pin | How it is verified |
|----|-----------|--------------|--------------------|
| HL-1 | os-holo κ primitives (`makeObject`/`contentLink`/`sha256hex`/`blake3hex`/`atlasCoord`) + the conscience gate | `humuhumu33/os-holo`, vendored at [`holo/`](../holo) as a git submodule pinned at `c475f76cc6cc871331de7849f5a38b84e6452d02` | The seal ([`tools/holo/relock.mjs`](../tools/holo/relock.mjs)) computes the root κ via the upstream `makeObject` (never hand-rolled) and re-derives every closure byte to its κ (Law L5). The fork tool is byte-for-byte identical to upstream `system/tools/relock-app.local.mjs` except the three path constants. |
| HL-1 | The frame's own `os-closure.json` + apps catalog | the vendored frame (same pin) | The assembler ([`tools/holo/assemble-site.mjs`](../tools/holo/assemble-site.mjs)) folds the app additively and the witness asserts the 32 pre-existing frame apps are preserved and the entry κ matches the sealed lock. |
| HL-2 | HTTP/1.1 (RFC 7230) + WebSocket (RFC 6455) | the published standards + their canonical vectors: `SHA-1("abc")`, the RFC-6455 `Sec-WebSocket-Accept` worked example (`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) | The codec ([`web/src/lib/holo-wire.mjs`](../web/src/lib/holo-wire.mjs)) is exercised against a mock in-guest server; the witness asserts the canonical vectors and full request/response + frame round-trips. |
| HL-3 | The source tree (static property) | this repo | `grep` proves no `new WebSocket`/`new EventSource`/raw `fetch(` is constructed outside `web/src/lib/api.ts`, and that `api.ts` exposes the swap points. |
| HL-4 | holospaces-web source + the Rust/wasm32 compiler | `Hologram-Technologies/holospaces` `crates/holospaces-web/src/lib.rs`; the shim carried at [`tools/holo/patches/holospaces-web-riscv-loopback.patch`](../tools/holo/patches/holospaces-web-riscv-loopback.patch) | The patch adds `boot_devcontainer_routed_opfs_streamed_bridged` — the existing `boot_devcontainer_routed_opfs_streamed` body plus `machine.enable_loopback()`, exactly as `boot_devcontainer_bridged` does for the non-OPFS case and `boot_devcontainer_opfs_full` does on AArch64. Verified to compile for `wasm32-unknown-unknown` in this devcontainer (log: `vv/witness/holospaces-web-wasm32.log`). |
| HL-C (target) | holospaces `CC-33` (in-process loopback ingress) | `Hologram-Technologies/holospaces` — `crates/holospaces/src/emulator/net.rs` (`LoopbackIngress`) + `crates/holospaces/tests/cc33_guest_bridge.rs`; the wasm-bindgen surface `Workspace.dial_guest`/`guest_send`/`guest_recv` | The live target will dial the in-guest `web_server.py` exactly as `cc33_guest_bridge.rs` dials its `:8080` server; the holospaces suite is the external oracle for the ingress contract. |
| HL-B / HL-D (targets) | holospaces `CC-9` (RISC-V emulator boots Linux) + ADR-014 egress | holospaces `vv/suites/cc9-emulator.sh`, `cc16-network.sh` | The guest-boot + egress targets are anchored to the holospaces conformance suites that already witness the emulator and its NAT. |

## Cross-repo conformance check (toolchain proof)

This repo shares the holospaces devcontainer (Rust stable + `wasm-pack` + `qemu-system-riscv64` + `just`
+ Node), so holospaces' own conformance suites run here unchanged. As a standing proof that the
substrate authority is reproducible in this environment, `vv/` records a run of holospaces **CC-1**
(κ-labels equal the reference hash implementations) executed via:

```
cargo test --manifest-path .holo-ref/holospaces/Cargo.toml -p holospaces --test cc1_kappa_kat
```

(`.holo-ref/` is a gitignored scratch clone; see [docs/holospaces/conformance.md](../docs/holospaces/conformance.md)
for the recorded result.)
