# Hermes in Holospaces: Implementation Plan

HEAD: plan completed against source. Every load-bearing claim is now verified against the fork tree
and against pinned clones of `humuhumu33/os-holo` and `Hologram-Technologies/holospaces`; coordinates
are cited inline as `repo:path:line`. The seal tool is confirmed byte-identical to upstream; the
"single chokepoint" claim is corrected (there are four live socket sites plus one raw export fetch that
bypass the `api.ts` helpers); the `base:'./'`/xterm worry is closed (no `import.meta.url`/`new Worker`
chunks exist); the Stage-A registration step is expanded into its real upstream tool chain; and both
open seams (B1 boot, C1 ingress) are resolved — ingress is first-class (`Workspace.dial_guest`,
witnessed by `CC-33`), and the one genuinely missing piece is a single ~6-line `holospaces-web` boot
function that combines relay egress + OPFS + loopback on the RISC-V target (the AArch64 path already
has it). What remains open is sized, not unknown: riscv64 image/kernel provenance, the κ-disk size
budget, the wasmi performance posture, and the per-provider egress choice.

Scope: the complete implementation of the existing `hermes-agent` (this `hermes-web` fork) running
inside holospaces, in-browser, served from GitHub Pages from the `hermes-web` branch. No surface beyond
what the fork already ships. Section 5 fences the non-goals.

> Reference clones used for verification (read-only):
> - os-holo → `humuhumu33/os-holo` @ default (2093 files)
> - holospaces → `Hologram-Technologies/holospaces` @ default (665 files)
> Coordinates below are stable within those revisions; re-verify line numbers after pinning a rev.

---

## 1. Conceptual model

### 1.1 hermes-agent, the complete system

Hermes is a model-agnostic, self-improving tool-calling agent. The runtime is Python: `run_agent.py`
and `cli.py` drive the loop; `model_tools.py`, `toolsets.py`, and `toolset_distributions.py` define and
route tools; any OpenAI-compatible endpoint backs it (`hermes model`, `providers/`, credential pool).
The persistence spine is `hermes_state.py`: a SQLite store with FTS5 session search holding sessions,
messages, analytics, and skill-usage. The learning loop is built on that spine: autonomous skill
creation, in-use skill improvement, an agent-curated memory with periodic nudges (the Curator),
cross-session FTS recall with LLM summarization, and Honcho user modeling. Around the core sit
toolsets, skills (`skills/`, `optional-skills/`, the agentskills.io hub with trust levels and scan),
MCP (`mcp_serve.py`, server catalog), a messaging gateway (`gateway/`: Telegram, Discord, Slack,
WhatsApp, Signal, CLI from one process, with pairing and webhooks), a cron scheduler with automation
blueprints, subagents for parallel workstreams, multi-profile management, and research tooling
(`batch_runner.py`, `trajectory_compressor.py`). The agent's shell executes on a terminal backend:
local, Docker, SSH, Singularity, Modal, or Daytona.

The agent surfaces through four faces: the CLI/TUI (`ui-tui`, `tui_gateway`, `hermes_cli`), the desktop
app (`apps/desktop`), the gateway channels, and the web dashboard (`web/`).

### 1.2 hermes-web, the dashboard, and its coupling

`web/` is the dashboard SPA (Vite, React 19, TypeScript; xterm for the embedded terminal). It is served
by `hermes_cli/web_server.py`, which injects one-shot globals into `index.html`:
`window.__HERMES_SESSION_TOKEN__`, `window.__HERMES_BASE_PATH__`, and `window.__HERMES_AUTH_REQUIRED__`
(`hermes_cli/web_server.py:11678-11687`; base path derived from the `X-Forwarded-Prefix` header,
`:11622-11667`).

The data layer is *intended* to funnel through one module, `web/src/lib/api.ts`: REST via
`fetchJSON`/`authedFetch`, sockets via `buildWsUrl` (`web/src/lib/api.ts:289-300`), with the typed `api`
object wrapping those. **This is the lever for the lift, but it is not airtight today** — see §1.6.
That gap is small and enumerable, and Stage A closes it as pre-work so the seam becomes the single
chokepoint the rest of the plan assumes.

The surface, grouped by what it manages: status and system (`/api/status`, `/api/system/stats`,
`/api/logs`); sessions (list, messages, FTS search, stats, rename, delete, prune, export, bulk); the
live chat (`/api/ws`, `/api/events`, `/api/pub`, and the `/api/pty` pseudo-terminal that backs the
embedded TUI); skills and the hub; toolsets; config and env; model selection; memory; analytics; cron
and automation blueprints; profiles; MCP servers; messaging platforms, Telegram onboarding, pairing;
OAuth providers and the credential pool; webhooks; gateway lifecycle and `hermes update`; ops (doctor,
security audit, backup, import, hooks, checkpoints, curator, portal); dashboard plugins, themes, fonts;
and auth (`/api/auth/me`, ws-ticket in gated mode). Two server modes exist: loopback (session-token
header `X-Hermes-Session-Token`) and gated (OAuth cookie + single-use WS ticket).

### 1.3 The holospaces substrate

Two layers compose, the way `os-holo` already vendors `holospaces` as a submodule.

The **os-holo frame** is the thin desktop holospace: a Linux FHS root realized as a content-addressed
semantic graph, sealed per node, served by a service worker (`os-holo:system/os/holo-fhs-sw.js`) out of
OPFS or a dumb static host. The worker re-derives every response to its κ on its axis and refuses on
mismatch — Law L5 (`holo-fhs-sw.js:549-562`) — healing a missing/wrong byte from a non-origin source
before refusing; it stamps cross-origin-isolation headers (`holo-fhs-sw.js:37-46`: COOP `same-origin`,
**COEP `credentialless`**, CORP `cross-origin`, CSP `frame-ancestors 'self'`, `X-Frame-Options
SAMEORIGIN`), and caches by κ with a write-through to a durable OPFS tier. One pure rule
(`os-holo:system/os/lib/holo-fhs-map.mjs`) maps the flat URL space to FHS paths, shared by dev server
and worker so dev and Pages resolve identically (Law L2): `apps/<id>/…` → `usr/share/holospaces/<id>/…`
(`holo-fhs-map.mjs:20`) and `…/_shared/<x>` → `usr/lib/holo/<x>` (`:18`). An app is a `holospace.json`
manifest (W3C `SoftwareApplication`: `id` names a storage scope, `entry`, `capabilities`) plus a
`holospace.lock.json` whose root κ is the app's identity; the launcher derives a least-privilege iframe
sandbox from the declared capabilities. The frame exposes agent doors under `/.well-known`
(`agents.json`, `agent-facts.json`, `mcp.json`, `agent-card.json`, `constitution.json`,
`skills/index.json`; `os-holo:system/os/.well-known/`); the worker itself answers a serverless MCP and
a serverless κ-stream REST surface with no origin server. A fail-closed conscience object
(`os-holo:system/os/usr/lib/holo/holo-conscience.js`) gates actions and is pinned into every app
closure as `_shared/holo-conscience.js`. Persistence is the OPFS κ-store; every closure entry is
dual-axis (`did:holo:sha256` for serving, a `did:holo:blake3` anchor for the substrate), and the app
root carries a self-derived Φ-Atlas-12288 coordinate. The launcher
(`os-holo:system/os/usr/share/frame/holospace.html`) mounts an app by resolving its `entry` to the
catalog's `dcat:landingPage` (or reconstructing `apps/<id>/<entry>`) and setting the sandboxed iframe
`src = "./" + landing` (`holospace.html:113,150`), so the in-frame service-worker resolver serves the
closure by κ.

The **holospaces emulator** (the vendored submodule) is the execution surface. ADR-009: a RISC-V RV64GC
system emulator compiled to a hologram Wasm container, bound only to the substrate host ABI, verified
against the official `riscv-tests` suite. Given an `HGOS` boot descriptor (kernel-image κ + device-tree
κ) it becomes SBI firmware and boots an unmodified Linux to userspace. It presents VirtIO devices;
ADR-014 gives the guest `virtio-net` behind a userspace TCP/IP NAT with tunneled **egress** (a
WebSocket relay, since a tab has no raw NIC). The κ-disk is a content-addressed block device that
ingests OCI `tar+gzip`/`tar+zstd` layers (`holospaces:crates/holospaces/src/assembly.rs`) and assembles
an ext4 rootfs. In the browser peer the container runs under `wasmi` (an interpreter; wasm32 has no
JIT), so interpreted RISC-V executing CPython is the dominant performance constraint — and ADR-019
states this browser peer is the **production** deployment, not a demo, so the cost is acknowledged, not
incidental.

### 1.4 The lift: the mapping

The complete system maps onto the substrate without reimplementation:

- **UI → app object.** The `hermes-web` dashboard becomes the os-holo app `foundation.uor.hermes`:
  `holospace.json` + sealed lock, built with `base: './'`, mounted in a least-privilege sandboxed
  iframe, served by κ on Pages.
- **Agent → guest.** The Python runtime is packaged as a `linux/riscv64` OCI image (Python 3.11, node
  ≥20, ripgrep, ffmpeg, git, Hermes), ingested into the κ-disk and booted under the emulator. Hermes's
  own `local` terminal backend is that guest; no new backend is introduced.
- **Server-calls → hologram.** The `api.ts` seam routes the dashboard's `/api` and four sockets to the
  real `web_server.py` running inside the guest, reached over the guest's network stack via the
  in-process loopback ingress bridge (`Workspace.dial_guest`, §3 Stage C). The Python API is not
  rebuilt in JS; the bridge is transport, not logic. The serverless property holds because the server
  runs in the in-browser emulator. Agent doors and the constitution wrap the app at the frame level.
- **State → κ-store.** The SQLite/FTS5 state (`hermes_state.py`) lives on the guest filesystem backed
  by the OPFS-paged κ-disk, so sessions, skills, memory, and the curator persist across browser
  sessions.
- **Egress → relay or direct.** Hermes's LLM calls and hub fetches leave through `virtio-net` →
  userspace NAT → WebSocket relay, or direct browser `fetch` for CORS-permissive providers (COEP
  `credentialless` permits cross-origin fetch without the resource opting in). Keys are supplied at
  runtime through the app's capability/env surface, never baked into the public deploy.

### 1.5 Substrate-bounded features

Three existing features are constrained by a single-tab serverless host. They are accounted for, not
replaced and not removed:

- **Gateway messaging** (Telegram/Discord/Slack/WhatsApp/Signal) are long-lived inbound services. A tab
  is not an always-on inbound host, so the gateway surface renders but cannot serve platforms without a
  persistent peer. The dashboard's gateway/messaging/pairing/webhook panels report this state.
- **agent-browser (Playwright)** and **voice transcription** assume a real browser and audio-capable
  ffmpeg on the host that the emulated guest does not nest. These tools degrade to no-ops; the agent
  loop, skills, memory, sessions, and toolsets that do not depend on them are unaffected.
- **`hermes update`** and host-level **ops/psutil stats** re-scope to the guest. The change is in what
  they report, nothing more.

### 1.6 The transport seam is not yet a single chokepoint (correction)

The original plan asserted "Nothing in the component tree hand-rolls a fetch or socket URL." That is
**false as written** and must be corrected before Stage A's transport abstraction can work. Verified
exceptions in `web/src` that bypass `buildWsUrl`/`fetchJSON`:

| Site | File:line | What it does |
|------|-----------|--------------|
| `/api/pty` socket | `web/src/pages/ChatPage.tsx:59` (URL), `:614` (`new WebSocket`) | builds `${proto}//${host}${HERMES_BASE_PATH}/api/pty?…` inline |
| `/api/ws` socket | `web/src/lib/gatewayClient.ts:137` (URL), `:136` (`new WebSocket`) | builds `${scheme}//${host}${HERMES_BASE_PATH}/api/ws?…` inline |
| `/api/events` socket | `web/src/components/ChatSidebar.tsx:249` (URL), `:248` (`new WebSocket`) | builds `${proto}//${host}${HERMES_BASE_PATH}/api/events?…` inline |
| session export | `web/src/pages/SessionsPage.tsx:1135` | raw `fetch(api.exportSessionUrl(id), …)` — URL helper, but bypasses `fetchJSON` |

`/api/pub` is a POST that does go through `fetchJSON`. So the real seam is: `fetchJSON` (REST) +
`buildWsUrl` (one socket) + **three inline socket builders** + **one raw export fetch**. Stage A
unifies all four bypasses through a single swappable `openSocket()` factory and routes the export
through `fetchJSON`, so the "one chokepoint" premise becomes true rather than assumed.

---

## 2. Current state (verified against source)

**Repo reality check.** The three artifacts pasted into the design notes — `relock.mjs`,
`holospace.json`, `icon.svg` — and the prior root-κ checkpoint are **authored but not yet placed in
this tree**. Verified absences: no `apps/hermes/`, no `holo/` (frame not vendored), no
`tools/holo/relock.mjs`. No build, seal, or registration has been run in this repo. The previously
quoted root κ `did:holo:sha256:39f536a6…` is from an external prior build that used Vite `base: '/'`;
it is stale by construction (Law L5: absolute `/assets/…` refs do not resolve into the closure) and
**will change** on the base fix + reseal. It should not be treated as a current fact.

**Seal-tool fidelity — confirmed byte-identical to upstream.** The fork's `relock.mjs` reproduces
`os-holo:system/tools/relock-app.local.mjs` exactly; only the three path constants (`FRAME`/`APPS`/`RT`)
are repointed. Field-by-field verification:

| Element | upstream `relock-app.local.mjs` | fork `relock.mjs` | match |
|---|---|---|---|
| `TYPE` ext→@type map | `:32-34` | identical 10-entry map | ✓ |
| closure entry shape (`kappa`/`sri`/`multibase`/`bytes`/`alsoKnownAs`) | `:44-46` | identical | ✓ |
| `links` via `contentLink(...) + schema:name` | `:46` | identical | ✓ |
| `links.sort` by `id` | `:64` | identical | ✓ |
| root `makeObject` object (type+`prov:Entity`, `hosc:` context, name/description/category/identifier/featureList/capabilities/`prov:wasGeneratedBy`/links) | `:66-77` | identical | ✓ |
| lock shape (`@context`/`root`/`identifier`/`algo`/`holo:within`/`holo:atlasCoordinate`/`files`/`closure`) | `:88-92` | identical | ✓ |
| conscience gate auto-pin as `_shared/holo-conscience.js` | `:62-63` | identical | ✓ |

The root κ is produced by upstream `makeObject` (`os-holo:system/os/usr/lib/holo/holo-object.mjs:127-133`,
hashing the JCS of the object minus `id`/`alsoKnownAs`) and `contentLink`
(`holo-object.mjs:93-102`, keys `id`/`rel`/`@type`/`leaf`/`digestSRI`/`digestMultibase`) — never
hand-computed. So a fork seal re-derives identically to an upstream seal. **This is the one part of the
prior "verified" claim that holds without qualification.**

**`holospace.json` review.** Accepted, with notes (no blockers):
- `id: foundation.uor.hermes` is the κ-identity and storage scope; it is distinct from the directory
  token `hermes` (see §3 "Identity vs directory token"). Both must stay consistent across five places.
- `capabilities: { storage: ["foundation.uor.hermes"] }` flows into the root as `hosc:capabilities` and
  into the launcher's sandbox derivation.
- No `shared` key → `relock.mjs` pins only the conscience gate into `_shared/`; the dashboard is fully
  self-contained under `apps/hermes/` (Vite bundles everything). Correct and intentional; make it
  explicit so a future reader does not expect `_shared/` runtime deps.
- `accent: "#7defc9"` is ignored by `gen-apps-catalog.mjs` (it reads only
  id/type/name/summary/applicationCategory/entry/icon/shared); harmless launcher hint.
- No `conforms.specs` → no `schema:featureList` in the root; fine (optional).

**Base-path / xterm worry — closed, not open.** The plan flagged xterm webgl/worker chunk URLs (emitted
via `new URL(asset, import.meta.url)`) as an open check under `base: './'`. Verified: there are **no**
`new URL(_, import.meta.url)` asset references and **no** `new Worker(` in `web/src`. `WebglAddon`
(`ChatPage.tsx:492`) is a normal bundled addon, not a worker chunk. Under `base: './'` Vite emits
relative `./assets/…` refs in `index.html`, which resolve into the closure. The only residual check is
mechanical: confirm the built `index.html` contains no leading-slash asset paths after the base flip
(one grep at seal time).

---

## 3. Implementation stages

Dependencies set the order: the guest must exist before the dashboard can bridge to it. Stage A is
"UI on Pages"; Stages B–D are "move server-calls to hologram."

### Parameters fixed before Stage A

- **App id.** `foundation.uor.hermes` (chosen). Names the κ identity and storage scope; baked into the
  lock and into `os-closure.json` `apps[].identifier`.
- **Directory token.** `hermes` (chosen). Used as the path segment under `apps/`, under
  `usr/share/holospaces/`, in closure keys (`apps/hermes/…`), and in the catalog `dcat:landingPage`
  (`apps/hermes/index.html`).
- **Frame pin.** Vendor `humuhumu33/os-holo` at a fixed rev under `holo/` (consumed unchanged). Record
  the rev in the submodule/lockfile so the seal primitives and the SW are reproducible.

**Identity vs directory token (must hold in five places).** The id `foundation.uor.hermes` and the
directory token `hermes` are different strings by design. They must line up as:
1. source dir `apps/hermes/` (the `relock.mjs` arg);
2. served FHS dir `usr/share/holospaces/hermes/` (via `holo-fhs-map.mjs:20`);
3. closure keys `apps/hermes/*` (relock output);
4. catalog `dcat:landingPage: apps/hermes/index.html` (`gen-apps-catalog.mjs` uses the *dir*);
5. `os-closure.json` `apps[].identifier = foundation.uor.hermes` with `root = <app root κ>`, which
   `gen-apps-catalog.mjs:18` cross-references by `id` to stamp the catalog κ.

### Stage A. UI as a holospace app object (the shell)

Objective: Pages (served from the `hermes-web` branch) boots the frame, the launcher lists Hermes, the
app mounts in-frame and renders, every byte re-derives to its κ. No live data.

Work:
1. **Vendor the frame.** Add `humuhumu33/os-holo` as a submodule at `holo/` at a pinned rev (supplies
   the worker, runtime primitives, FHS map, catalog/staging tools, conscience gate, agent doors).
2. **Unify the transport seam (pre-work, from §1.6).** Refactor the three inline socket builders
   (`ChatPage.tsx:59/614`, `gatewayClient.ts:136-137`, `ChatSidebar.tsx:248-249`) to call a single
   `openSocket(path, params)` factory in `api.ts` (built on `buildWsUrl`), and route
   `SessionsPage.tsx:1135` through `fetchJSON`. This is a behavior-preserving refactor in
   server-hosted mode and is the precondition for a swappable transport.
3. **Base flip.** `web/vite.config.ts`: `base: './'`. (Build still emits to `../hermes_cli/web_dist`;
   for the app object the sealed input is that `dist` placed under `apps/hermes/`.) Verify the built
   `index.html` has no leading-slash asset refs.
4. **Pluggable transport behind the seam.** Introduce a transport interface behind
   `fetchJSON`/`openSocket`. Default transport = today's HTTP-to-`/api` (server-hosted build unchanged).
   A `static` transport activates when no backend/token is present: reads answer with empty states,
   `openSocket` returns a no-op socket, so the shell is navigable rather than throwing.
5. **Place + seal.** Copy `web_dist` → `apps/hermes/` alongside `holospace.json` + `icon.svg`, then
   `FRAME=holo APPS=apps node tools/holo/relock.mjs hermes`. Output: `apps/hermes/holospace.lock.json`
   with the real (post-base) root κ.
6. **Register (the real upstream tool chain, not a single edit).** In order:
   - `copy-content.mjs` (`os-holo:system/tools/copy-content.mjs:36`) — place `apps/hermes/*` bytes into
     `usr/share/holospaces/hermes/` per the FHS map.
   - `compute-manifest.mjs` / `bundle-sdk-shell.mjs`
     (`os-holo:system/tools/compute-manifest.mjs:27-37`, `bundle-sdk-shell.mjs:47-84`) — seal the app's
     closure entries into `etc/os-closure.json`'s `closure` map (the SW's primary κ source via
     `holo-fhs-sw.js:219-222` `loadClosure` → `BYPATH`), and add `{ identifier: "foundation.uor.hermes",
     root: <app root κ> }` to `os-closure.json` `apps[]` (shape per `etc/os-closure.json`).
   - `gen-apps-catalog.mjs` (`os-holo:system/tools/gen-apps-catalog.mjs`) — regenerate
     `apps/index.jsonld` (`schema:name/identifier/description/applicationCategory`,
     `dcat:landingPage: apps/hermes/index.html`, `schema:image: apps/hermes/icon.svg`; κ pulled from
     `os-closure.json apps[]` by `id`).
   The SW serves the app either from the OS closure (`BYPATH`) or from the app's own
   `apps/hermes/holospace.lock.json` (whose keys are already serve-rel; `holo-fhs-sw.js:241,249`).
   Whichever the staging uses, the per-file κ must exist in one of those two manifests or the SW
   refuses (L5).
7. **Pages workflow (diverges from upstream — state it).** Upstream `os-holo:.github/workflows/pages.yml`
   commits prebuilt app locks and CI only stages + deploys (no relock in CI). This fork **rebuilds
   `web/` in CI**, so the lock is not committable as-is; the fork's workflow MUST run, in order:
   `npm ci` → `vite build` (base `./`) → place under `apps/hermes/` → `relock.mjs` → `copy-content` →
   `compute-manifest`/`bundle` → `gen-apps-catalog` → stage `_site` → `actions/deploy-pages`. Deploy
   from the `hermes-web` branch.

Verify: a boot witness modeled on `os-holo:system/tools/boot-os2-witness.mjs` (which asserts
`/holospace.html`, `/apps/index.jsonld`, `/apps/<id>/holospace.{json,lock.json}`, `/apps/<id>/index.html`
all resolve) — extended to assert the Hermes app root κ resolves and the entry renders under L5.

Exit: navigable shell on Pages from `hermes-web`, content-addressed, no live backend.

### Stage B. the agent runtime in the emulator

Objective: the unmodified Python Hermes boots and runs inside the in-browser RISC-V guest, with state
on the κ-store.

Work:
- **Build the image.** `buildx --platform linux/riscv64` carrying Python 3.11, node ≥20, ripgrep,
  ffmpeg, git, and the fork. Reuse the existing `Dockerfile` as the content baseline, retargeted to
  riscv64. (Arch coverage is a sized risk — §4.)
- **Provision the rootfs in-browser.** Use `DevcontainerProvision(image_ref, "riscv64")`
  (`holospaces:crates/holospaces-web/src/lib.rs:129-231`): the page pumps `next_url`/`deliver` to pull
  the OCI layers through the router, then `assemble_into_opfs(rootfs_handle, disk_bytes)` re-derives
  every blob (L5) and writes a bootable ext4 rootfs into OPFS. A real OCI image carries no `/init`, so
  the `REAL_IMAGE_INIT` shim is injected automatically.
- **Boot path.** Supply a riscv64 Linux **kernel image** (bytes) to the boot fn; the **DTB is generated
  by the Boot Orchestrator** (`machine.rs` device-tree generation), *not* hand-produced — so the prior
  "produce a DTB κ" step is unnecessary on the web path. For Stage B alone (boot + persistence, egress
  optional), use `boot_devcontainer_routed_opfs_streamed(kernel, rootfs_handle, disk_handle)`
  (`lib.rs:1316`). Persistence: the OPFS `disk_handle` is the paged κ-store, so `hermes_state.py`'s
  SQLite/FTS5 store is OPFS-backed and durable across reloads.

Verify: a guest-boot witness asserting the kernel reaches userspace and `python run_agent.py --help`
returns inside the guest (reach it via the loopback bridge once Stage C's boot fn lands, or via the
console during Stage B), content-addressed.

Exit: Hermes runs in the guest; state survives a tab reload.

### Stage C. bind the dashboard transport to the substrate

Objective: the dashboard's `/api` and sockets reach the guest's `web_server.py`; "server-calls on
hologram."

**Seam C1 — RESOLVED. Ingress is first-class.** The host tab can open a connection *into* a guest
listening port. The mechanism is the in-process loopback ingress bridge (ADR-020 / `CC-33`):
`Workspace.dial_guest(guest_port) -> id`, then `guest_send(id, bytes)` / `guest_recv(id) -> bytes` /
`guest_close(id)` / `guest_is_open(id)` (`holospaces-web/src/lib.rs:1491-1516`), backed by
`LoopbackIngress` (`crates/holospaces/src/emulator/net.rs:1482-1596`) and the `Ingress` trait
(`net.rs:123-150`). It is **witnessed end-to-end**: `crates/holospaces/tests/cc33_guest_bridge.rs`
boots a guest, runs a TCP server on `:8080`, `dial_guest(8080)`, sends `GET / HTTP/1.0\r\n…`, pumps,
and reads back the guest's HTTP response. So the dashboard→guest bridge needs **no NAT shim** — it is
the same transport the VS Code remote server uses.

**The one real shim (precise, ~6 lines).** Hermes needs egress (LLM) + OPFS (state) + loopback ingress
(dashboard) *simultaneously*, on **RISC-V**. No exported RISC-V web boot fn currently combines all
three: `boot_devcontainer_bridged` enables loopback but with `NoEgress` (`lib.rs:1241-1245`);
`boot_devcontainer_routed_opfs*` give routed egress + OPFS but never call `enable_loopback()`
(`lib.rs:1290,1316`). The **AArch64** path already does all three in one fn
(`boot_devcontainer_opfs_full`, `lib.rs:1759-1790`: routed egress + OPFS-streamed + `enable_loopback()`).
The shim is to add the RISC-V analogue — a `boot_devcontainer_routed_opfs_streamed` that also calls
`machine.enable_loopback()` before returning the `Workspace` (or, if `Workspace` re-exports
`enable_loopback`, call it post-boot from JS, as `cc33_guest_bridge.rs` does on the native machine).
This is a fork-local addition to `holospaces-web`, modeled byte-for-byte on the AArch64 fn.

Work:
- **Implement the `hologram` transport behind the `api.ts` seam.** It is an **HTTP/1.1 + WebSocket
  client over the loopback byte stream**, not a `fetch` shim: for each REST call, dial the guest's
  `web_server.py` port, serialize the request line + headers + body, `guest_send`, pump `run(budget)`,
  accumulate `guest_recv` until the response is complete, parse it. For the four sockets
  (`/api/ws`, `/api/events`, `/api/pub` POST already covered, `/api/pty`), perform an RFC-6455 upgrade
  over the same dial and frame/de-frame messages. The unified `openSocket()` from Stage A is what this
  transport swaps in for.
- **Auth.** Replace the injected `__HERMES_SESSION_TOKEN__` handshake with the app's capability
  identity; map the gated-mode ws-ticket flow onto the frame's auth, or drop it for the
  loopback-equivalent in-frame path (the bridge is in-process, so the loopback trust model applies).
- **Streams.** Bridge `/api/pty` to the guest console/PTY fd and `/api/ws`+`/api/events`+`/api/pub` to
  the guest event stream, all through the loopback connection(s).

Verify: a transport witness exercising a read (`/api/status`), a verb (`/api/model/set`), and a live
`/api/pty` round-trip against the guest, all through the seam — modeled on the `CC-33` request/response
witness.

Exit: every realizable dashboard surface is live against the in-guest Hermes; substrate-bounded panels
(§1.5) report their inert state.

### Stage D. convergence

Objective: the complete agent, end to end, in the browser.

Work:
- **Egress, decided per provider.** Two faithful options: (a) substrate path — boot with
  `boot_devcontainer_net(kernel, rootfs, relay_url)` (`lib.rs:1212`) so guest TCP tunnels over a
  WebSocket relay; (b) direct browser `fetch` from the dashboard JS to CORS-permissive providers (COEP
  `credentialless` permits cross-origin fetch without a CORP opt-in). Note the shim consequence: the
  Stage-C combined boot fn must layer relay egress (or `ChannelEgress` router) onto the
  OPFS+loopback machine; `boot_devcontainer_net` as-shipped uses `MemKappaStore` and no loopback, so it
  is not the convergence boot fn by itself. Keys are runtime-only via the app's env/capability path,
  never baked into the deploy.
- **Learning loop.** Confirm skill creation, curator nudges, FTS recall, and memory persist across
  reloads on the OPFS κ-disk.
- **Performance posture.** Resolve demonstrator-first (accept wasmi interpreter speed, prove the loop)
  vs. native-engine investigation (§4); ADR-019 frames the browser peer as production, so the bar is
  "acceptable first boot," not "fast."

Verify: a full-loop witness — a chat turn that calls a tool in the guest, writes a session to the
κ-store, and is recoverable by FTS search after a tab reload.

Exit: the existing hermes-agent runs complete in holospaces from Pages (`hermes-web` branch).

---

## 4. Residual open seams (sized, not unknown)

The two boot/ingress seams the prior plan listed are resolved above. What remains is genuinely
external/quantitative, not architectural:

- **The Stage-C boot-fn shim.** Adding the RISC-V `routed_opfs + enable_loopback` (and the egress
  variant for Stage D) to `holospaces-web`. Fully specified; modeled on `lib.rs:1759-1790`. Decide:
  fork `holospaces-web`, or upstream the function.
- **riscv64 image arch.** Toolchain coverage for the full dependency set (Python 3.11 wheels, node,
  ripgrep, ffmpeg) under `linux/riscv64`; provenance of the riscv64 kernel image; whether any dep lacks
  a riscv64 build and needs source compilation in the image.
- **κ-disk size budget.** A ~3 MB UI closure plus a Python userland (interpreter + wheels + ffmpeg +
  git) is the OPFS footprint; size `disk_bytes` in `assemble_into_opfs` with headroom for `apt`/builds
  and confirm OPFS quota on the target browsers.
- **Performance.** wasmi-interpreted RISC-V executing CPython is the dominant cost (ADR-019). Decide
  demonstrator-first vs. investigating whether the emulator codemodule may run on the browser's native
  wasm engine against the closed-host-surface law (`CC-5`).
- **Egress path per provider.** Relay (faithful) vs. direct CORS fetch (fully static); keys runtime-only.

---

## 5. Non-goals (scope fence)

Not in this plan: holo-messenger or any new application; Playground integration; any product surface the
fork does not already ship; a JavaScript reimplementation of Hermes's Python API; and any replacement
for the substrate-bounded features in §1.5. The deliverable is exactly the existing `hermes-agent`,
complete, running in holospaces, deployed from the `hermes-web` branch.
