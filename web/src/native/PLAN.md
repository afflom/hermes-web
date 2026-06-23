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

## BDD gates
- **G1 runtime** — full Hermes imports under Pyodide. ✅
- **G2 dashboard** — real `/api` reads+writes < 2 s native. ✅
- **G4 dashboard-complete** — every local dashboard tab native in the browser. ✅
- **G5 transport split** — the chat WebSocket routes to the guest while the dashboard stays native; both live
  under one client. *(Supersedes the old "process surface" G5 — that surface does not exist.)*
  - **G5a** the native in-process ASGI WS driver accepts `/api/ws` + emits `gateway.ready` (single-threaded
    proof the driver is correct). Blocked natively only by the gateway's import-time thread → confirms the split.
  - **G5b** the dual-worker router: HTTP→native, WS→guest, shared token, in the browser.
- **G6 agent** — a full chat turn (LLM + tool use) completes over the guest WS while the dashboard is native.
- **G3 fs** — state coherence: native HOME mounted on the guest FS over CC-15 (a chat write shows in the
  dashboard's Sessions/history reads).
- **G7 egress** — the agent's outbound LLM/tool traffic over the reused extension bridge (guest path).
- **G8 deploy** — the live Pages instance is a completely functional hermes-agent: native dashboard + guest
  agent, `?native=1` promoted to default once G5b/G6/G3 are green.

## Sequence
1. ✅ Bundle + runtime + native dashboard (G1/G2/G4). 2. ✅ Native ASGI WS driver (G5a — correct; proves the
threaded gateway needs the guest). 3. Dual-worker router: HTTP→native, WS→guest (G5b). 4. Chat turn over the
split (G6). 5. State coherence via CC-15 (G3). 6. Egress (G7). 7. Promote `?native=1` to default; the guest is
retained as the threaded-agent substrate, NOT retired (G8).

## What changed from the first plan (honest record)
The first plan assumed the holospace might expose a host process surface that would let the guest be *dropped
entirely* once the agent ran native. It does not — threads/processes live only in the guest. So the guest is not
retired; it becomes the **agent substrate** in a per-transport split, with native-exec accelerating the
dashboard. The interpreter wall is removed for the read-heavy common case, kept (in the guest) only for the
inherently-threaded agent — which is where the substrate's real OS genuinely earns its cost.
