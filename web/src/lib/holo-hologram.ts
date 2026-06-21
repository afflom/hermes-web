// holo-hologram.ts — boot the dashboard's data plane entirely in the browser, on the k-theory /
// holospaces substrate. No remote backend: the real Hermes `web_server.py` runs inside an in-browser
// content-addressed RISC-V guest (holospaces-web wasm). The dashboard's REST + WebSocket calls reach it
// over the in-process loopback bridge, and the AGENT's outbound calls (model APIs, git, pip/npm) leave
// the guest NAT through the holospaces router extension — both serviced by one continuous BridgeRuntime.
//
// The expensive cold boot (~24 min interpreted) is paid ONCE by the native witness and banked as a
// content-addressed warm κ; here the browser RESUMES that κ (`resume_devcontainer_net_bridged`) in
// seconds — CPU+RAM+disk+9p restored, the loopback ingress AND a router egress re-attached. The session
// token is read from the in-guest server itself (it injects `window.__HERMES_SESSION_TOKEN__`).

import { loadWarmSnapshot, type WarmLoadProgress } from "./holo-cas";
import { BridgeRuntime, type HoloWorkspace } from "./holo-runtime";
import { awaitEgressExtensionId, connectEgress } from "./holo-egress";

/** The subset of the holospaces-web wasm module this bootstrap uses (snake_case wasm-bindgen exports). */
interface HsModule {
  default: (input?: unknown) => Promise<unknown>;
  kappa: (bytes: Uint8Array) => string;
  Workspace: {
    resume_devcontainer_net_bridged: (snapshot: Uint8Array) => HoloWorkspace;
  };
}

export interface HologramBootProgress {
  phase: "wasm" | "snapshot" | "disk" | "resume" | "attach" | "egress" | "token" | "ready" | "error";
  detail?: string;
  /** 0..1 within a phase that reports sub-progress (the snapshot fetch). */
  fraction?: number;
}

const GUEST_PORT = 9119;
const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
const EMBEDDED_RE = /window\.__HERMES_DASHBOARD_EMBEDDED_CHAT__\s*=\s*(true|false)/;
const AUTH_RE = /window\.__HERMES_AUTH_REQUIRED__\s*=\s*(true|false)/;

let hsPromise: Promise<HsModule> | null = null;
let runtime: BridgeRuntime | null = null;

function holoUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}holo/${rel}`.replace(/([^:])\/\//g, "$1/");
}

/** Load + initialize the holospaces-web wasm once (a `--target web` wasm-bindgen module). */
export async function loadHs(): Promise<HsModule> {
  if (!hsPromise) {
    hsPromise = (async () => {
      const mod = (await import(/* @vite-ignore */ holoUrl("holospaces_web.js"))) as HsModule;
      await mod.default();
      return mod;
    })();
  }
  return hsPromise;
}

/** Adopt the in-guest session token by fetching the server's own HTML over the bridge, with retries
 * (the resumed server takes a few ticks to re-accept loopback connections). Publishes the token +
 * auth/embedded flags on `window` so `api.ts#getSessionToken` resolves and protected calls authenticate. */
async function adoptSessionToken(rt: BridgeRuntime): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await rt.fetch("/", { headers: { accept: "text/html" } });
      const html = await res.text();
      const m = html.match(TOKEN_RE);
      if (m) {
        const w = window as unknown as Record<string, unknown>;
        w.__HERMES_SESSION_TOKEN__ = m[1];
        const em = html.match(EMBEDDED_RE);
        w.__HERMES_DASHBOARD_EMBEDDED_CHAT__ = em ? em[1] === "true" : true;
        const au = html.match(AUTH_RE);
        w.__HERMES_AUTH_REQUIRED__ = au ? au[1] === "true" : false;
        return m[1];
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`in-guest dashboard never served a session token${lastErr ? `: ${lastErr}` : ""}`);
}

/** Confirm a protected /api call answers over the bridge — proves the resumed server is truly serving. */
async function verifyApi(rt: BridgeRuntime, token: string): Promise<void> {
  const res = await rt.fetch("/api/status", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`in-guest /api/status did not answer (status ${res.status})`);
}

/** The active runtime (for diagnostics / teardown), once booted. */
export function activeRuntime(): BridgeRuntime | null {
  return runtime;
}

/**
 * Boot the in-browser Hermes backend and install the bridge transport. On success the dashboard's /api +
 * WebSocket calls speak to the resumed in-guest server (authenticated with its token), and the agent's
 * outbound calls egress through the router extension when present. Throws on failure (the caller shows
 * an honest error — the data plane is holospaces or nothing).
 */
export async function bootHologramTransport(report: (p: HologramBootProgress) => void = () => {}): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  const t0 = Date.now();
  // Beacon every phase to `window` (+ elapsed) so tests/devtools see exactly where a long boot is.
  const onProgress = (p: HologramBootProgress) => {
    w.__HOLO_BOOT_PHASE__ = p.phase;
    w.__HOLO_BOOT_DETAIL__ = p.detail ?? "";
    w.__HOLO_BOOT_ELAPSED__ = ((Date.now() - t0) / 1000).toFixed(1);
    report(p);
  };

  onProgress({ phase: "wasm", detail: "loading the holospaces runtime" });
  const hs = await loadHs();

  onProgress({ phase: "snapshot", detail: "fetching the warm Hermes machine" });
  const snapshot = await loadWarmSnapshot(
    (bytes) => hs.kappa(bytes),
    (p: WarmLoadProgress) =>
      onProgress({
        phase: p.phase === "verify" || p.phase === "persist" ? "resume" : "snapshot",
        detail: p.detail,
        fraction: p.fraction,
      }),
  );

  onProgress({ phase: "resume", detail: "resuming the warm machine (no cold boot)" });
  const ws = hs.Workspace.resume_devcontainer_net_bridged(snapshot);

  // Re-attach egress through the router extension if it's installed (the agent's outbound network).
  // Absent → the dashboard still works; the agent's network features prompt for the extension.
  onProgress({ phase: "egress", detail: "connecting the agent's network" });
  const extId = await awaitEgressExtensionId(1200);
  const egress = extId ? connectEgress(extId) : null;

  onProgress({ phase: "attach", detail: "re-attaching the loopback transport" });
  runtime = new BridgeRuntime(ws, { port: GUEST_PORT, egress });
  runtime.start();
  runtime.install();

  onProgress({ phase: "token", detail: "authenticating with the in-guest server" });
  // Adopting the token means the in-guest server already served a real HTTP request over the loopback
  // bridge — that IS the end-to-end proof the resumed backend is live and serving. Heavier /api routes
  // run the in-guest Python (slow under interpreted RISC-V), so we don't block readiness on them.
  const token = await adoptSessionToken(runtime);

  // Diagnostic hooks: exercise the REAL bridge transport (REST + WebSocket) from tests/devtools.
  w.__HOLO_FETCH__ = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return runtime!.fetch(path, { ...init, headers });
  };
  w.__HOLO_WS__ = (path: string) => {
    const sep = path.includes("?") ? "&" : "?";
    return runtime!.openSocket(`${path}${sep}token=${encodeURIComponent(token)}`);
  };

  w.__HOLO_BACKEND_READY__ = true;
  w.__HOLO_EGRESS_READY__ = !!egress;
  onProgress({ phase: "ready", detail: "in-browser backend live" });

  // Confirm a protected /api route in the BACKGROUND (non-blocking) — it proves the Python app, not
  // just the static SPA, answers. Surfaces on window for diagnostics; never blocks the boot.
  void verifyApi(runtime, token)
    .then(() => {
      w.__HOLO_API_OK__ = true;
    })
    .catch((e) => {
      w.__HOLO_API_OK__ = false;
      console.warn("[holo] /api/status verification (background) did not complete:", e);
    });
}
