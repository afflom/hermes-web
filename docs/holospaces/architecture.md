# hermes-web on holospaces — architecture

The Pages deploy of hermes-web is **not** a static, backend-less dashboard. It runs the real Hermes
backend (`hermes_cli/web_server.py`, the `/api` + WebSocket server) **inside the browser**, on the
k-theory / holospaces substrate, and routes the dashboard's data plane to it over an in-process
loopback bridge. No remote backend; no Hologram-OS desktop frame.

## The pieces

| Concern | Where |
| --- | --- |
| In-browser RISC-V emulator + content-addressed substrate | `holospaces-web` wasm, vendored at `web/public/holo/` |
| The Hermes guest userland (linux/riscv64) | `docker/holo/Dockerfile.riscv64` → OCI image |
| Bank the warm κ (boot once, snapshot) | `tools/holo/witness/cc_hermes_guest.rs` (native witness) |
| Warm κ → shippable content-addressed chunks | `tools/holo/chunk-warm-kappa.mjs` → `web/public/holo/warm/` |
| Fetch + verify the warm κ in the browser | `web/src/lib/holo-cas.ts` |
| Load wasm → resume → bridge → token | `web/src/lib/holo-hologram.ts` |
| Wire the bridge to the dashboard's fetch/WS seam | `web/src/lib/holo-transport.ts` (codec: `holo-wire.mjs`) |
| Boot gate / graceful fallback UI | `web/src/components/HologramBoot.tsx` |
| Transport selection | `web/src/lib/holo-bootstrap.ts` |

## Boot flow (browser)

1. `HologramBoot` gates the app. `bootHologramTransport` loads the vendored wasm (`loadHs`).
2. `loadWarmSnapshot` fetches the warm κ: OPFS cache first (verified by re-derivation, Law L5;
   ADR-019), else the content-addressed chunks (each pinned by its own SHA-256), reassembled and
   L5-verified against the substrate κ (`hs.kappa`, blake3). Persisted to OPFS for instant warm-starts.
3. `Workspace.resume_devcontainer_bridged(snapshot)` restores the warm machine (CPU+RAM+disk+9p) and
   re-attaches the loopback ingress — **no cold boot**.
4. The machine is pumped until the in-guest server re-accepts a loopback dial (the live net transport
   is re-established fresh on resume).
5. `installHologramTransport` points `api.ts`'s fetch + socket seam at the bridge. The session token is
   read from the in-guest server's own served HTML (it injects `window.__HERMES_SESSION_TOKEN__`) — so
   auth is live. A protected `/api/status` over the bridge confirms the chain; `__HOLO_BACKEND_READY__`
   is set only then.

If any step fails (no warm κ published, OPFS blocked, …) the dashboard degrades to the static
empty-state transport — the real chrome with empty states, never a stub placeholder.

## The exploit: pay the interpreted boot once (CC-30/CC-31)

The cold boot is a real Linux/RISC-V boot + Python/Hermes import under a wasm interpreter — minutes, not
seconds. The substrate's answer is snapshot/resume: the native witness boots **once**, snapshots the
serving machine to a content-addressed κ, and that κ is what every browser **resumes** (seconds,
byte-for-byte; the resumed machine re-derives to the same κ — Law L1/L5). GitHub's 100 MB-per-file
limit is met by shipping the κ as content-addressed chunks (it is content; its chunks are content too).

## The wasm32 resume budget — the load-bearing constraint

Guest RAM is 512 MiB. `Emulator::snapshot` embeds **RAM + the full disk image + the 9p workspace**;
`resume_devcontainer_bridged` → `Emulator::restore` rebuilds the disk in an in-wasm `MemKappaStore`
(sectors dedup'd, but resident on the wasm heap). wasm32 caps linear memory at 4 GiB, and resume
briefly holds the incoming snapshot bytes **and** the rebuilt structures. So:

- **If `512 MiB RAM + disk + 9p` resumes within the wasm32 budget** → the implemented monolithic
  `resume_devcontainer_bridged` is the whole story. Ship the chunked κ; done.
- **If it does not** → the disk must live off the wasm heap. The substrate already has the mechanism
  (`OpfsKappaStore`: "the KappaStore IS the memory, RAM is a cache", a bounded 2 MiB sector cache) — but
  today only the *boot* paths use it. The fix is an **OPFS-streamed resume**: ship the post-boot disk as
  a content-addressed OPFS-streamed file and resume only the warm RAM/CPU/9p state, backing VirtIO-blk
  with the OPFS κ-store. This keeps the **full** Hermes guest (no narrowing) and fits wasm32. It is a
  substrate (Rust) addition to `holospaces-web` + a wasm rebuild.

The deciding measurement is the assembled rootfs size, reported by the boot witness
(`[hermes-guest] dense rootfs assembled: N bytes`). The deploy pipeline branches on it.
