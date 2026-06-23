# Native-exec hermes-agent — full implementation plan (DRY, BDD-gated)

## Goal
hermes-web = a **completely functional hermes-agent**, deployed to GitHub Pages, optimized with the
hologram/holospaces native-exec approach: run the **real, unmodified Hermes Python** as fast as the substrate
allows, with the OS primitives it can't host (threads, processes, persistent FS) provided by the **holospace**
over the CC-33 bridge. We *remove the interpreter wall where it isn't needed*, not the substrate.

## Resolved architecture: ALL-NATIVE (the interpreter wall removed for the whole agent)
The bottleneck is the emulator interpreter wall: the wasm emulator re-executes the guest's first-ASGI path
every browser session (>360 s "establishment"). κ-warming can't capture it (the bank already warms all
endpoints; the browser still re-pays), so the only elimination is to **stop emulating — run native**. Two OS
primitives Pyodide lacks blocked the agent from the native path; both are now backed cooperatively in the ONE
`os_surface` seam, reusing the established substrate — NOT by emulating a CPU:

1. **Threads.** Pyodide can't host OS threads (and there is no host thread surface: CC-11 is a terminal *inside*
   the guest; the CC-48 ext-host borrows only fs). So the **cooperative thread surface** runs the real threaded
   `tui_gateway` on the single event loop: `Thread.start()` runs inline; a blocking `Condition.wait` inside a
   coop thread (the base of `Event.wait` / `queue.get` / background poll loops) unwinds — the single page
   session has no second thread to satisfy it — while the non-blocking `wait(0)` fast path and already-ready
   handoffs are untouched. Proven: gateway handshake + dispatch + a **full chat turn** run native (node 9/9).
2. **Network (the LLM call).** Pyodide ships no `ssl`, so the HTTPS LLM call uses the BROWSER's TLS via the
   **established egress** — the router extension's CORS-free fetch (its content role). One httpx-transport patch
   (`os_net.install_http_egress`) routes every model SDK through it; `run_sync` (JSPI, present in the deploy
   browser) bridges the sync SDK call to the async fetch. No new egress model — the same one the guest used.

Therefore the deployed backend is **ONE native-exec worker serving the WHOLE backend** behind the one
holo-protocol — no emulator, no split, no guest:

| Surface | How (all native, one Pyodide worker) |
|---------|--------------------------------------|
| **HTTP `/api/*`** (dashboard) | the real ASGI app in-process via httpx ASGITransport (15 ms vs >360 s) |
| **WebSocket `/api/ws`** (chat / agent) | the real threaded gateway in-process via the ASGI-WS driver + the cooperative thread surface |
| **LLM egress** | the agent's httpx → the established extension CORS-free fetch (browser TLS), `run_sync`-bridged |
| **State (FS HOME)** | Pyodide FS (OPFS-persisted HOME is the G3 refinement) |

`?native=1` selects all-native (one `web/src/native/worker.ts`). It is opt-in until the cross-origin LLM egress
(extension CORS-free POST) is verified end-to-end; then it becomes the default and the emulated guest retires.

### Superseded: the per-transport split
An earlier increment ran native HTTP + guest WS (the agent on the guest, dialed over CC-33), on the premise
that real threads exist only in the guest. The cooperative thread surface removed that premise — the threaded
agent runs native — so the split (and the guest) is retired. Recorded for trace; the all-native path replaces it.

## Principle: DRY, parametric, no bespoke
- **Reuse the real Hermes Python verbatim** (no fork) and **reuse the established egress** (the extension
  CORS-free fetch). The OS surfaces (threads, network) are ONE adapter each, not per-call patches.
- **Single sources of truth.** Deps from `pyproject.toml`; source is the repo tree; ONE OS-surface adapter, ONE
  native runtime, ONE ASGI bridge (HTTP via httpx ASGITransport, WS via the in-process driver).
- **Parametric** over the full agent — whole source + full dep set.

## The DRY pieces
1. **`bundle-hermes-native.mjs`** (build) — tars the whole repo's Python + a `pyproject`-derived dep manifest.
2. **`runtime.ts`** — env-agnostic native backend: installs deps, unpacks source, OS-surface adapter, serves the
   real ASGI app in-process. HTTP via `httpx.ASGITransport`; **WS via the in-process ASGI websocket driver**
   (`_NativeWS`) — present and correct, used for any single-threaded socket; the *threaded* `/api/ws` routes to
   the guest instead.
3. **`os_surface.py`** — the ONE OS-surface adapter. Absent-OS modules degrade to catchable `OSError`. The
   process/thread seam *raises* (no host surface exists) — the guest provides those, not a stub.
4. **`worker.ts`** (native) — boots Pyodide + the bundle; speaks the holo-protocol for HTTP.
5. **`holo-worker.ts`** (guest) — unchanged; serves the threaded agent over CC-33 (chat WS, egress).
6. **`holo-client.ts`** — the **dual-worker router**: native worker for HTTP, guest worker for WS, one protocol.
7. **FS-over-CC-15 adapter** — a Pyodide FS that proxies HOME to the guest filesystem so state is coherent.

## BDD gates (all-native; the split gates are superseded — kept in git history)
- **G1 runtime** — the full Hermes Python imports under Pyodide. ✅ (node)
- **G2 dashboard** — real `/api` reads+writes round-trip native-fast (15 ms vs >360 s). ✅ (node + browser)
- **G4 dashboard-complete** — every local dashboard tab renders native in the browser. ✅
- **G5 thread surface** — the REAL threaded `tui_gateway` runs native on the cooperative thread surface:
  imports past its daemon reaper, serves the `/api/ws` handshake, and dispatches JSON-RPC; background poll
  loops (`queue.get`/`Event.wait` → `Condition.wait`) unwind cooperatively. ✅ (node 9/9 + browser gateway gate)
- **G6 agent** — a FULL chat turn runs all-native: agent build + the streaming LLM call over the egress
  (`run_sync`/JSPI bridges sync httpx ↔ the async fetch; the bridge args are `to_js`'d so postMessage can clone
  them) → the assistant reply streams back. ✅ (node 9/9 + browser full-turn gate, same-origin mock model)
- **G7 egress** — the agent's outbound LLM call rides the ESTABLISHED extension egress: same-origin/CORS-OK
  direct; cross-origin providers via the extension's CORS-free fetch (content channel, POST-capable). ✅ wired +
  same-origin browser-verified; cross-origin to a real provider verified live.
- **G3 fs** — state persistence across boots (OPFS-persisted HOME). Refinement, pending.
- **G8 deploy** — promote `?native=1` to the default and retire the emulated guest once the cross-origin LLM is
  verified live. The guest remains the verified default until then (full chat via its CC-16 egress).

## Sequence (done)
1. ✅ Bundle + runtime + native dashboard (G1/G2/G4). 2. ✅ Cooperative thread surface → native threaded gateway
(G5). 3. ✅ Network surface: the httpx egress over the established extension fetch (G7). 4. ✅ Full chat turn
native (G6). 5. State coherence via OPFS HOME (G3). 6. Promote native to default + retire the guest (G8).

## What changed from the first plan (honest record)
The first plan assumed the holospace might expose a host process surface that would let the guest be *dropped
entirely* once the agent ran native. It does not — there is no host thread/process surface (CC-11 is a guest
terminal; the ext-host borrows only fs). So threads are backed COOPERATIVELY in the one os_surface seam (run the
real threaded server on the event loop), and the network is backed by the established extension egress over the
postMessage bridge. With both, the WHOLE agent runs native — the guest is retired, not kept as a substrate.
