// holo-client.ts — the main-thread router for the holospaces backend. It hosts the dashboard's transport seam
// (api.ts setFetchImpl / setSocketFactory) and forwards /api REST + WS calls to the worker(s) over postMessage,
// relaying the agent's egress frames between the worker and the router extension (chrome.runtime is main-thread
// only). Installs exactly like the in-process runtime did, so the dashboard is unchanged.
//
// Two transports, ONE protocol (the holospaces-idiomatic per-transport split, PLAN.md G5):
//   • HTTP  /api/*  → the NATIVE worker (Pyodide): the real Hermes Python on the browser peer's JS engine,
//                     single-threaded, native-fast — the dashboard's read/write common case.
//   • WS    /api/ws → the GUEST worker (emulated holospace): the agent gateway is fundamentally THREADED, and
//                     real threads exist only inside the guest's real OS, dialed over CC-33.
// `?native=1` selects this split; without it, ONE guest worker serves both halves (current production), so the
// two roles collapse onto a single worker and the same code path drives both.

import { setFetchImpl, setSocketFactory, resetTransport, HERMES_BASE_PATH } from "./api";
import { guestRelativePath } from "./holo-transport";
import { connectEgress, connectContentFetch, awaitEgressExtensionId, type EgressChannel, type ContentFetcher } from "./holo-egress";
import type { ToWorker, FromWorker } from "./holo-protocol";
import type { HologramBootProgress } from "./holo-hologram-types";

type Listener = (ev: { type: string; data?: unknown; code?: number; reason?: string }) => void;

// The two transport backends. In single-worker (production) mode httpWorker === wsWorker.
let httpWorker: Worker | null = null;
let wsWorker: Worker | null = null;
let splitMode = false;
let nextRid = 1;
let nextSid = 1;
const pendingFetch = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
const liveSockets = new Map<number, WorkerSocket>();
let egress: EgressChannel | null = null;
let contentFetcher: ContentFetcher | null = null; // the native agent's cross-origin LLM call (CORS-free via the extension)
// The WS backend's session token (T_guest). In the split it differs from the HTTP backend's token, so WS
// upgrades must be (re)authed against the guest, not whatever token the dashboard built into the URL.
let guestToken = "";
// May we actually dial the guest yet? The factory is installed early (so chat sockets are WorkerSockets, never
// a real `new WebSocket` against the origin), but the wsopen is held until the guest is WARM. Dialing during
// the guest's one-time post-resume establishment would contend with the background warm-up probe for the
// guest's single serving lane. Sockets created before then queue in pendingOpens and flush on arm.
let socketsArmed = false;
const pendingOpens: WorkerSocket[] = [];

function sendHttp(msg: ToWorker, transfer?: Transferable[]) {
  httpWorker!.postMessage(msg, transfer ?? []);
}
function sendWs(msg: ToWorker, transfer?: Transferable[]) {
  wsWorker!.postMessage(msg, transfer ?? []);
}

/** Allow guest dials and flush any chat sockets that queued while the guest was booting/establishing. */
function armSockets(): void {
  if (socketsArmed) return;
  socketsArmed = true;
  for (const s of pendingOpens.splice(0)) if (s.readyState === WorkerSocket.CONNECTING) s._open();
}

/** A WebSocket-like whose I/O is serviced by the guest worker's BridgeRuntime over postMessage. */
class WorkerSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  private listeners: Record<string, Set<Listener>> = {};
  readonly sid: number;
  readonly rawUrl: string; // as the dashboard built it; the guest token is applied at dial time (_open)

  constructor(url: string) {
    this.sid = nextSid++;
    this.rawUrl = url;
    liveSockets.set(this.sid, this);
    // The guest may still be booting/establishing (it warms in the background while the native dashboard is
    // already live). Defer the upgrade until armed rather than racing a wsopen at a not-yet-warm guest.
    if (socketsArmed) this._open();
    else pendingOpens.push(this);
  }
  _open() { sendWs({ t: "wsopen", sid: this.sid, path: guestWsPath(this.rawUrl, splitMode) }); }
  _emit(type: string, ev: { type: string; data?: unknown; code?: number; reason?: string }) {
    const own = (this as unknown as Record<string, Listener | null>)["on" + type];
    if (typeof own === "function") own(ev);
    for (const l of this.listeners[type] || []) l(ev);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") { sendWs({ t: "wssend", sid: this.sid, data, binary: false }); return; }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    const u = bytes.slice().buffer as ArrayBuffer; // a fresh, transferable ArrayBuffer copy
    sendWs({ t: "wssend", sid: this.sid, data: u, binary: true }, [u]);
  }
  close(): void {
    if (this.readyState === WorkerSocket.CLOSED) return;
    this.readyState = WorkerSocket.CLOSING;
    const i = pendingOpens.indexOf(this); if (i >= 0) pendingOpens.splice(i, 1);
    if (socketsArmed) sendWs({ t: "wsclose", sid: this.sid });
    this.readyState = WorkerSocket.CLOSED;
    liveSockets.delete(this.sid);
  }
  addEventListener(type: string, l: Listener): void { (this.listeners[type] ??= new Set()).add(l); }
  removeEventListener(type: string, l: Listener): void { this.listeners[type]?.delete(l); }
}

/** The fetch installed into api.ts: strip the deploy base, forward to the HTTP (native) worker, await it. */
function workerFetch(input: string, init?: RequestInit): Promise<Response> {
  const path = guestRelativePath(input, HERMES_BASE_PATH);
  const method = (init?.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const body = typeof init?.body === "string" ? init.body : init?.body == null ? undefined : String(init.body);
  const rid = nextRid++;
  return new Promise<Response>((resolve, reject) => {
    pendingFetch.set(rid, { resolve, reject });
    sendHttp({ t: "fetch", rid, path, method, headers, body });
  });
}

/** Re-author a WS URL onto the guest: strip whatever auth the dashboard built in (it carries the HTTP/native
 *  token in the split) and append the guest's token, which is what the guest's /api/ws auth checks. */
function guestWsPath(url: string, split: boolean): string {
  const rel = guestRelativePath(url, HERMES_BASE_PATH);
  if (!split) return rel; // single-worker mode: the one token in the URL is already the guest's — pass through
  const qIdx = rel.indexOf("?");
  const path = qIdx >= 0 ? rel.slice(0, qIdx) : rel;
  const params = new URLSearchParams(qIdx >= 0 ? rel.slice(qIdx + 1) : "");
  params.delete("token"); params.delete("ticket"); params.delete("internal");
  if (guestToken) params.set("token", guestToken);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Handle the data-plane messages that are identical regardless of which worker emitted them. Returns true
 *  when handled. (fetchres/fetcherr come from the HTTP worker; the ws events + egressout from the guest worker
 *  — but the pendingFetch/liveSockets maps disambiguate by rid/sid, so one handler body serves both.) */
function handleData(m: FromWorker): boolean {
  switch (m.t) {
    case "fetchres": {
      const p = pendingFetch.get(m.rid); if (!p) return true; pendingFetch.delete(m.rid);
      p.resolve(new Response(m.body && m.body.byteLength ? m.body : null, { status: m.status, statusText: m.statusText, headers: new Headers(m.headers) }));
      return true;
    }
    case "fetcherr": { const p = pendingFetch.get(m.rid); if (p) { pendingFetch.delete(m.rid); p.reject(new Error(m.message)); } return true; }
    case "wsopened": { const s = liveSockets.get(m.sid); if (s) { s.readyState = WorkerSocket.OPEN; s._emit("open", { type: "open" }); } return true; }
    case "wsmsg": { const s = liveSockets.get(m.sid); if (s) s._emit("message", { type: "message", data: m.data }); return true; }
    case "wsclosed": { const s = liveSockets.get(m.sid); if (s) { s.readyState = WorkerSocket.CLOSED; s._emit("close", { type: "close", code: m.code, reason: m.reason }); liveSockets.delete(m.sid); } return true; }
    case "wserr": { const s = liveSockets.get(m.sid); if (s) s._emit("error", { type: "error", data: m.message }); return true; }
    case "egressout": egress?.send(m.frame); return true; // carry the guest's frame to the extension
    case "apiok": {
      (window as unknown as Record<string, unknown>).__HOLO_API_OK__ = m.ok;
      // In the split, the guest serves only WS — its warm-up probe (this apiok) is what pays the one-time
      // post-resume establishment. Only once it's warm is the single guest lane free to dial chat sockets.
      if (m.ok && splitMode) armSockets();
      return true;
    }
    case "peakbytes": (window as unknown as Record<string, unknown>).__HOLO_PEAK_BYTES__ = m.bytes; return true;
    case "log": {
      if (m.level === "guest") for (const line of m.msg.split("\n")) console.log("%c[hermes]", "color:#7c3aed", line);
      else if (m.level === "error") console.error("[holo]", m.msg);
      else if (m.level === "warn") console.warn("[holo]", m.msg);
      else console.info("[holo]", m.msg);
      if (/^(auth wait:|resumed|warm machine|wasm runtime|in-guest server)/.test(m.msg)) {
        (window as unknown as Record<string, unknown>).__HOLO_DIAG__ = `${m.msg}`;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Answer the native agent's outbound HTTPS (the LLM call) — the worker can't reach chrome.runtime, so the
 *  request lands on the main thread. A same-origin endpoint (e2e mock, or a CORS-enabled provider) resolves via
 *  the page's fetch directly; cross-origin providers (CORS-blocked) route through the extension's CORS-free
 *  fetch (the established content egress), wired with the cross-origin-provider increment. */
async function answerHttpFetch(worker: Worker, m: Extract<FromWorker, { t: "httpfetch" }>): Promise<void> {
  try {
    // A cross-origin provider (api.anthropic.com, …) is CORS-blocked from the page, so route it through the
    // extension's CORS-free fetch (the established egress). Same-origin (e2e mock, a co-hosted/CORS-OK endpoint)
    // resolves via the page's fetch directly.
    const crossOrigin = new URL(m.url, location.href).origin !== location.origin;
    if (crossOrigin && contentFetcher) {
      const r = await contentFetcher.fetch({ method: m.method, url: m.url, headers: m.headers, body: m.body });
      worker.postMessage({ t: "httpfetchres", fid: m.fid, status: r.status, headers: r.headers, body: r.body, error: r.error }, [r.body]);
      return;
    }
    const res = await fetch(m.url, {
      method: m.method,
      headers: m.headers,
      body: m.body && m.body.byteLength ? m.body : undefined,
    });
    const buf = await res.arrayBuffer();
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    worker.postMessage({ t: "httpfetchres", fid: m.fid, status: res.status, headers, body: buf }, [buf]);
  } catch (e) {
    const empty = new ArrayBuffer(0);
    worker.postMessage({ t: "httpfetchres", fid: m.fid, status: 0, headers: [], body: empty, error: String(e) }, [empty]);
  }
}

/** Boot the worker-hosted backend. Resolves once the HTTP (dashboard) backend serves; the guest WS backend
 *  finishes booting in the background and wires the socket factory when ready. */
export async function bootWorkerTransport(report: (p: HologramBootProgress) => void = () => {}): Promise<void> {
  const t0 = Date.now();
  const onProgress = (p: HologramBootProgress) => {
    const w = window as unknown as Record<string, unknown>;
    w.__HOLO_BOOT_PHASE__ = p.phase;
    w.__HOLO_BOOT_DETAIL__ = p.detail ?? "";
    w.__HOLO_BOOT_ELAPSED__ = ((Date.now() - t0) / 1000).toFixed(1);
    report(p);
  };

  // Backend selection (DRY — same protocol either way). `?native=1` runs the WHOLE backend NATIVE: ONE
  // native-exec worker (the real Hermes Python on the browser peer's JS engine, Pyodide) serves the dashboard
  // HTTP, the threaded agent WS (the cooperative thread surface), AND the LLM-call egress — no emulator, so
  // none of its cost (128 s boot, 377 MB κ, >360 s establishment). Without it, the emulated warm-κ guest serves
  // both (current production: real cross-origin LLM over CC-16). All-native is opt-in until its cross-origin
  // LLM egress (the extension's CORS-free fetch) is verified, then it becomes the default and the guest retires.
  const native = typeof location !== "undefined" && new URLSearchParams(location.search).get("native") === "1";
  splitMode = false; // one worker serves both transports — the per-transport split is retired (the agent runs native)
  const newGuest = () => new Worker(new URL("./holo-worker.ts", import.meta.url), { type: "module", name: "holospaces" });
  httpWorker = wsWorker = native
    ? new Worker(new URL("../native/worker.ts", import.meta.url), { type: "module", name: "hermes-native" })
    : newGuest();

  // Wire the agent's egress (outbound LLM/tool traffic) to the router extension if present — this belongs to the
  // GUEST worker, where the agent runs (relay guest <-> extension).
  const extId = await awaitEgressExtensionId(1200);
  egress = extId ? connectEgress(extId) : null;
  egress?.onFrame((frame) => sendWs({ t: "egressin", frame }, [frame.buffer]));
  // The native agent's cross-origin LLM call rides the same extension's CORS-free fetch (content channel).
  contentFetcher = extId ? connectContentFetch(extId) : null;

  // Install the dashboard's HTTP transport + the WS factory + diagnostic hooks once the HTTP backend serves,
  // then resolve. The WS factory is installed HERE (early) so the dashboard's chat opens a WorkerSocket (which
  // queues until the guest is warm) instead of a real `new WebSocket` against the origin — the guest token is
  // applied later, at dial time, once known.
  function installHttp(token: string) {
    setFetchImpl(workerFetch as unknown as (url: string, init?: RequestInit) => Promise<Response>);
    setSocketFactory((url: string) => new WorkerSocket(url) as unknown as WebSocket);
    const w = window as unknown as Record<string, unknown>;
    w.__HERMES_SESSION_TOKEN__ = token; // dashboard REST auth (T_http)
    w.__HOLO_BACKEND_READY__ = true;
    w.__HOLO_EGRESS_READY__ = !!egress;
    w.__HOLO_FETCH__ = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      return workerFetch(path, { ...init, headers });
    };
    w.__HOLO_WS__ = (path: string) => {
      const sep = path.includes("?") ? "&" : "?";
      return new WorkerSocket(`${path}${sep}token=${encodeURIComponent(token)}`); // auth: the gateway WS checks ?token=
    };
    // Seed-capture hook: a RAW guest GET that bypasses seed/status/egress handlers (capture e2e records the
    // backend's true response per path). Targets the HTTP backend.
    w.__HOLO_CAPTURE__ = (path: string): Promise<Response> => {
      const rid = nextRid++;
      return new Promise<Response>((resolve, reject) => {
        pendingFetch.set(rid, { resolve, reject });
        sendHttp({ t: "capraw", rid, path, headers: { authorization: `Bearer ${token}` } });
      });
    };
  }

  // Record the guest's token once the guest backend serves. In single-worker mode the one worker is the guest,
  // so we arm immediately (current production: dashboard reads warm it). In the split we hold the dial until the
  // guest's warm-up probe reports apiok (establishment paid), so we don't contend for its single serving lane.
  function installWs(token: string) {
    guestToken = token;
    const w = window as unknown as Record<string, unknown>;
    w.__HOLO_AGENT_READY__ = true;
    armSockets(); // one worker serves WS immediately (native: no establishment; guest: dashboard reads warm it)
    onProgress({ phase: "ready", detail: native ? "native backend live (dashboard + agent)" : "in-browser backend live" });
  }

  await new Promise<void>((resolve, reject) => {
    // HTTP (native, or the shared guest) — drives the main boot UI + resolves bootWorkerTransport.
    httpWorker!.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.t === "httpfetch") { answerHttpFetch(httpWorker!, m); return; } // native agent's outbound LLM call
      if (handleData(m)) return;
      if (m.t === "progress") { onProgress(m.p); return; }
      if (m.t === "booterr") { reject(new Error(m.message)); return; }
      if (m.t === "ready") {
        const w = window as unknown as Record<string, unknown>;
        w.__HERMES_DASHBOARD_EMBEDDED_CHAT__ = m.embedded;
        w.__HERMES_AUTH_REQUIRED__ = m.authRequired;
        installHttp(m.token);
        installWs(m.token); // one worker → wire HTTP + WS together
        onProgress({ phase: "ready", detail: native ? "native backend live (dashboard + agent)" : "in-browser backend live" });
        resolve();
      }
    };
    httpWorker!.onerror = (e) => reject(new Error(`${native ? "native" : "guest"} worker error: ${e.message}`));

    // OPFS disk paging is opt-in (?holo-resume=opfs): lower memory but slower than the monolithic resume.
    const opfs = typeof location !== "undefined" && new URLSearchParams(location.search).get("holo-resume") === "opfs";
    const diag = typeof location !== "undefined" ? new URLSearchParams(location.search).get("holo-diag") ?? undefined : undefined;
    // Egress-prober endpoints BLOCK in the guest waiting for a network reply; with no gateway that reply never
    // comes and the stuck handler holds the guest's single serving slot. Tell the guest whether egress is wired.
    const bootMsg: ToWorker = { t: "boot", base: HERMES_BASE_PATH, opfs, diag, egressAvailable: !!egress };
    httpWorker!.postMessage(bootMsg); // httpWorker === wsWorker (one worker serves both transports)
  });
}

/** Tear down the worker transport (restore api.ts defaults). */
export function stopWorkerTransport(): void {
  resetTransport();
  httpWorker?.terminate();
  if (wsWorker && wsWorker !== httpWorker) wsWorker.terminate();
  httpWorker = wsWorker = null;
  contentFetcher?.close();
  contentFetcher = null;
  socketsArmed = false;
  splitMode = false;
  guestToken = "";
  pendingOpens.length = 0;
}
