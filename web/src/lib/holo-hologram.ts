// holo-hologram.ts — boot the dashboard's data plane entirely in the browser, on the k-theory /
// holospaces substrate. No remote backend: the real Hermes `web_server.py` runs inside an in-browser
// content-addressed RISC-V guest (holospaces-web wasm), and the dashboard's REST + WebSocket calls
// reach it over the emulator's in-process loopback bridge (`holo-transport.ts`).
//
// The expensive cold boot (~24 min interpreted) is paid ONCE by the native witness and banked as a
// content-addressed warm κ; here the browser RESUMES that κ (`resume_devcontainer_bridged`) in
// seconds — CPU+RAM+disk+9p restored byte-for-byte (CC-30/CC-31), the loopback ingress re-attached so
// `dial_guest` reaches the still-listening server. The session token is read from the in-guest server
// itself (it injects `window.__HERMES_SESSION_TOKEN__` into the HTML it serves), so auth is live.

import { fromWorkspace, installHologramTransport, holoFetch, type GuestBridge } from "./holo-transport";
import { loadWarmSnapshot, hasWarmManifest, type WarmLoadProgress } from "./holo-cas";

/** The subset of the holospaces-web wasm module this bootstrap uses (snake_case wasm-bindgen exports). */
interface HsModule {
  default: (input?: unknown) => Promise<unknown>;
  kappa: (bytes: Uint8Array) => string;
  Workspace: {
    resume_devcontainer_bridged: (snapshot: Uint8Array) => HsWorkspace;
  };
}
interface HsWorkspace {
  dial_guest(p: number): number | undefined;
  guest_send(id: number, d: Uint8Array): void;
  guest_recv(id: number): Uint8Array;
  guest_close(id: number): void;
  guest_is_open(id: number): boolean;
  run(budget: number): boolean;
}

export interface HologramBootProgress {
  phase: "wasm" | "snapshot" | "resume" | "attach" | "token" | "ready" | "error";
  detail?: string;
  /** 0..1 within a phase that reports sub-progress (the snapshot fetch). */
  fraction?: number;
}

const GUEST_PORT = 9119;
const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
const EMBEDDED_RE = /window\.__HERMES_DASHBOARD_EMBEDDED_CHAT__\s*=\s*(true|false)/;

let hsPromise: Promise<HsModule> | null = null;

/** Base-aware URL for the vendored wasm glue shipped under `${BASE}holo/`. */
function holoUrl(rel: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base}holo/${rel}`.replace(/([^:])\/\//g, "$1/");
}

/** Load + initialize the holospaces-web wasm once. The glue is a `--target web` wasm-bindgen module:
 * its default export initializes the instance (resolving the `.wasm` relative to the glue's own URL). */
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

/** Pump the machine until its in-guest server accepts a loopback connection (the live net transport is
 * re-established fresh on resume, so the server needs a few ticks to re-accept). Returns when a dial
 * succeeds, or throws after the budget is exhausted. */
function awaitGuestListening(ws: HsWorkspace): void {
  for (let i = 0; i < 400; i++) {
    ws.run(2_000_000);
    const id = ws.dial_guest(GUEST_PORT);
    if (id != null) {
      ws.guest_close(id);
      return;
    }
  }
  throw new Error(`in-guest server never accepted a loopback dial on :${GUEST_PORT} after resume`);
}

/** Read the session token (and embedded-chat flag) from the in-guest server's own served HTML and
 * publish them on `window`, so `api.ts#getSessionToken` resolves and protected `/api`/WS calls
 * authenticate. The request MUST go over the bridge (`bridgeFetch`) — `window.fetch("/")` would hit the
 * static Pages host, not the in-guest server. Returns the adopted token. */
async function adoptSessionToken(bridgeFetch: ReturnType<typeof holoFetch>): Promise<string> {
  const res = await bridgeFetch("/", { headers: { accept: "text/html" } });
  const html = await res.text();
  const m = html.match(TOKEN_RE);
  if (!m) throw new Error("in-guest dashboard served HTML without a session token");
  const w = window as unknown as Record<string, unknown>;
  w.__HERMES_SESSION_TOKEN__ = m[1];
  const em = html.match(EMBEDDED_RE);
  w.__HERMES_DASHBOARD_EMBEDDED_CHAT__ = em ? em[1] === "true" : true;
  return m[1];
}

/** Confirm a protected /api call answers over the bridge — proves the resumed server is truly serving,
 * not just that HTML was scraped. Routes through `bridgeFetch`, with the adopted token. */
async function verifyApi(bridgeFetch: ReturnType<typeof holoFetch>, token: string): Promise<void> {
  const res = await bridgeFetch("/api/status", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`in-guest /api/status did not answer (status ${res.status})`);
}

/** True when this build can run the in-browser backend (a warm-κ manifest is published for it). */
export async function hologramAvailable(): Promise<boolean> {
  return hasWarmManifest();
}

/**
 * Boot the in-browser Hermes backend and install the hologram transport. On success the dashboard's
 * `/api` + WebSocket calls speak to the resumed in-guest server, authenticated with its token. Throws
 * on any failure (the caller decides whether to fall back to the static empty-state transport).
 */
export async function bootHologramTransport(onProgress: (p: HologramBootProgress) => void = () => {}): Promise<void> {
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
  const ws = hs.Workspace.resume_devcontainer_bridged(snapshot);

  onProgress({ phase: "attach", detail: "re-attaching the loopback transport" });
  awaitGuestListening(ws);
  const bridge: GuestBridge = fromWorkspace(ws);
  installHologramTransport(bridge, { port: GUEST_PORT });

  onProgress({ phase: "token", detail: "authenticating with the in-guest server" });
  const bridgeFetch = holoFetch(bridge, GUEST_PORT);
  const token = await adoptSessionToken(bridgeFetch);
  await verifyApi(bridgeFetch, token);

  // A truthful end-to-end signal for tests/diagnostics: set ONLY after resume + dial + transport +
  // token + a live protected /api call all succeeded over the in-process loopback bridge.
  (window as unknown as Record<string, unknown>).__HOLO_BACKEND_READY__ = true;
  onProgress({ phase: "ready", detail: "in-browser backend live" });
}
