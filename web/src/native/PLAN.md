# Native-exec hermes-agent — full implementation plan (DRY, BDD-gated)

## Goal
hermes-web = a **completely functional hermes-agent**, deployed to GitHub Pages, optimized with the
hologram/holospaces native-exec approach: run the **real, unmodified Hermes Python** as fast as the substrate
allows, with the OS primitives it can't host (threads, processes, persistent FS) provided by the **holospace**
over the CC-33 bridge. We *remove the interpreter wall where it isn't needed*, not the substrate.

## Resolved architecture: the per-transport split (the holospaces-idiomatic answer)
Investigation (CC-48 `node-exthost` + the local holo glue) established two load-bearing facts:

1. **Pyodide cannot host OS threads.** The stock build raises `RuntimeError: can't start new thread`; the only
   pthread build is an unreleased experimental branch whose spawned threads *cannot touch the JS FFI* (which our
   loopback bridge needs). So native-exec is single-threaded, period.
2. **Holospaces does not expose a host thread/process surface (CC-11).** CC-11 is a terminal *inside* the guest;
   the ext-host borrows only the **filesystem (CC-15)**. There is no `HOST.exec`/`HOST.thread` to wire — the
   `os_surface._install_process_surface` seam correctly *raises* rather than faking one. The guest is the only
   place real threads exist, and the host reaches it by **dialing a server over CC-33** (not borrowing syscalls).

Therefore the deployed backend is **two backends behind one holo-protocol, split by transport**:

| Transport | Backend | Why |
|-----------|---------|-----|
| **HTTP `/api/*`** (dashboard reads+writes) | **native-exec (Pyodide)** | single-threaded, native-fast (15 ms vs >360 s); the common case, usable in ~8 s |
| **WebSocket `/api/ws`** (chat / agent / tool exec) | **emulated guest** (`holo-worker`, dialed over CC-33) | the agent gateway is fundamentally threaded (`threading.Thread`, `Event`/`Lock`, `asyncio.to_thread`); real threads exist only in the guest |
| **State (FS HOME)** | **guest filesystem over CC-15**, mounted by native | one coherent store so a dashboard read sees what a chat turn wrote — the ext-host's one borrowed surface |

The dashboard is live native-fast while the guest boots in the background for chat. `holo-client` already
multiplexes the protocol; the change is to run *both* workers and route fetch→native, socket→guest.

## Principle: DRY, parametric, no bespoke
- **Reuse the real Hermes Python verbatim** (no fork) and **reuse both existing substrates** (native runtime +
  emulated guest). The split adds a router, not a new backend.
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
