# Native-exec hermes-agent — full implementation plan (DRY, BDD-gated)

## Goal
hermes-web = a **completely functional hermes-agent**, deployed to GitHub Pages, running the **real, unmodified
Hermes Python natively** (Pyodide on the browser peer's JS engine — CC-48's native-exec surface), with the OS
primitives (FS / process / terminal / network) provided by the **holospace** over the CC-33 bridge. We *remove
the interpreter wall* (Python in the emulated guest), not the substrate. Proven: the whole FastAPI app serves
`/api/config` in 15 ms native vs >360 s emulated.

## Principle: DRY, parametric, no bespoke
- **Reuse the real Hermes Python verbatim.** No fork, no stub of the backend. The deployed code IS the repo's
  Python, bundled by a build step.
- **Single sources of truth.** Deps come from `pyproject.toml`; source is the repo tree; there is exactly ONE
  OS-surface adapter, ONE runtime, ONE ASGI bridge — never per-module / per-dep patches.
- **Parametric.** Supports the full agent: the whole source + the full dep set (required eagerly, provider-optional
  lazily). New providers/tools need no hermes-web change.

## Architecture (the DRY pieces)
1. **`hermes-native-bundle`** (build step, `web/scripts/`): tars the real Hermes Python (`hermes_cli/`, `gateway/`,
   `agent/`, root modules…) + emits a dep manifest derived from `pyproject.toml`. One artifact, content-addressed.
2. **Native runtime worker** (`web/src/lib/native/runtime.ts`): loads Pyodide, installs the manifest deps, unpacks
   the source bundle, installs the OS-surface adapter, imports the real `web_server.app`. Replaces the emulated
   boot in `holo-worker.ts`.
3. **OS-surface adapter** (`web/src/lib/native/os_surface.py` + a JS bridge) — THE DRY core: one shim backing
   Python's `os`/`open`/`subprocess`/`pty`/`socket`/`psutil` with the holospace primitives over CC-33. The Python
   analogue of CC-48's `node-exthost` fs/net adapters. NOT per-module stubs.
   - filesystem → holospace FS (CC-15) / OPFS
   - process + terminal (subprocess / execvp / PTY) → holospace process surface (CC-11)
   - network (egress) → the existing extension bridge (`holo-egress`, reused)
4. **ASGI bridge** (`web/src/lib/native/asgi.ts`): the dashboard's `window.__HOLO_FETCH__` / WS → the in-Pyodide
   ASGI `app`. Reuse `holo-client`'s existing bridge surface so the dashboard is unchanged.
5. **Repurposed guest, not back-compat:** the emulated machine is reduced to (at most) the OS-primitive provider
   the agent's shell tools dial over the bridge; the Hermes Python no longer runs there. (If the holospace exposes
   a native process surface, the guest is dropped entirely — decided at gate 5.)

## BDD gates (each increment fails closed first, then made green)
- **G1 runtime** — the *full* Hermes imports under Pyodide (node + browser) with the parametric dep set.
- **G2 dashboard** — real `/api` reads **and writes** round-trip < 2 s in the browser (was >360 s).
- **G3 fs** — config/file persistence round-trips through the FS adapter.
- **G4 dashboard-complete** — every local dashboard tab loads native (the existing features.spec, repointed).
- **G5 process** — a real agent tool (a shell command / git) runs through the holospace process surface; output
  round-trips. *(This gate decides the guest's fate.)*
- **G6 agent** — a full chat turn (LLM + tool use) completes over the native backend.
- **G7 egress** — egress endpoints + the agent's outbound work over the reused extension bridge.
- **G8 deploy** — the live GitHub Pages instance is a completely functional hermes-agent (live smoke = G4+G6).

## Increments (sequenced; each lands its gate)
1. Bundle build + manifest (G1, node). 2. Native runtime worker (G1, browser). 3. FS adapter (G3) + dashboard
wiring (G2). 4. Repoint features.spec → native (G4). 5. Process surface adapter (G5) — the frontier. 6. Agent
loop + chat (G6). 7. Egress (G7). 8. Cut the deploy from emulated-κ to native; retire the κ pipeline (G8).

## Open frontier (called out honestly)
G5 (process surface) is the deep unknown: whether the holospace exposes a process/exec/PTY surface the agent's
`subprocess` can target, or whether that is itself substrate work in holospaces. Increments 1–4 (the proven
native dashboard) do not depend on it and deliver immediate value; G5 is where we confirm the path to *full*
agent functionality and decide the guest's role.

## What we retire (no back-compat)
The warm-κ emulated-guest path (`holo-worker` resume, the κ CAS, the establishment-hiding seed-served-auth, the
re-bank pipeline) is replaced once G4/G6/G8 are green — it remains only as the fallback until then.
