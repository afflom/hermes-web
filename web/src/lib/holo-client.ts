// holo-client.ts — the main-thread side of the holospaces Web Worker. It spawns the worker (which hosts
// the emulator + resume + pump), then exposes a thin `fetch`/`WebSocket` proxy that forwards the
// dashboard's /api + WS calls to the worker over postMessage, and relays the agent's egress frames
// between the worker and the router extension (chrome.runtime is main-thread only). Installs into the
// api.ts transport seam exactly like the in-process runtime did, so the dashboard is unchanged.

import { setFetchImpl, setSocketFactory, resetTransport, HERMES_BASE_PATH } from "./api";
import { guestRelativePath } from "./holo-transport";
import { connectEgress, awaitEgressExtensionId, type EgressChannel } from "./holo-egress";
import type { ToWorker, FromWorker } from "./holo-protocol";
import type { HologramBootProgress } from "./holo-hologram-types";

type Listener = (ev: { type: string; data?: unknown; code?: number; reason?: string }) => void;

let worker: Worker | null = null;
let nextRid = 1;
let nextSid = 1;
const pendingFetch = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
const liveSockets = new Map<number, WorkerSocket>();
let egress: EgressChannel | null = null;

function send(msg: ToWorker, transfer?: Transferable[]) {
  worker!.postMessage(msg, transfer ?? []);
}

/** A WebSocket-like whose I/O is serviced by the worker's BridgeRuntime over postMessage. */
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

  constructor(path: string) {
    this.sid = nextSid++;
    liveSockets.set(this.sid, this);
    send({ t: "wsopen", sid: this.sid, path });
  }
  _emit(type: string, ev: { type: string; data?: unknown; code?: number; reason?: string }) {
    const own = (this as unknown as Record<string, Listener | null>)["on" + type];
    if (typeof own === "function") own(ev);
    for (const l of this.listeners[type] || []) l(ev);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") { send({ t: "wssend", sid: this.sid, data, binary: false }); return; }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    const u = bytes.slice().buffer as ArrayBuffer; // a fresh, transferable ArrayBuffer copy
    send({ t: "wssend", sid: this.sid, data: u, binary: true }, [u]);
  }
  close(): void {
    if (this.readyState === WorkerSocket.CLOSED) return;
    this.readyState = WorkerSocket.CLOSING;
    send({ t: "wsclose", sid: this.sid });
    this.readyState = WorkerSocket.CLOSED;
    liveSockets.delete(this.sid);
  }
  addEventListener(type: string, l: Listener): void { (this.listeners[type] ??= new Set()).add(l); }
  removeEventListener(type: string, l: Listener): void { this.listeners[type]?.delete(l); }
}

/** The fetch installed into api.ts: strip the deploy base, forward to the worker, await the response. */
function workerFetch(input: string, init?: RequestInit): Promise<Response> {
  const path = guestRelativePath(input, HERMES_BASE_PATH);
  const method = (init?.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const body = typeof init?.body === "string" ? init.body : init?.body == null ? undefined : String(init.body);
  const rid = nextRid++;
  return new Promise<Response>((resolve, reject) => {
    pendingFetch.set(rid, { resolve, reject });
    send({ t: "fetch", rid, path, method, headers, body });
  });
}

function onWorkerMessage(ev: MessageEvent<FromWorker>, onReady: (token: string) => void, onProgress: (p: HologramBootProgress) => void, onError: (e: Error) => void) {
  const m = ev.data;
  switch (m.t) {
    case "progress": onProgress(m.p); break;
    case "ready": {
      const w = window as unknown as Record<string, unknown>;
      w.__HERMES_SESSION_TOKEN__ = m.token;
      w.__HERMES_DASHBOARD_EMBEDDED_CHAT__ = m.embedded;
      w.__HERMES_AUTH_REQUIRED__ = m.authRequired;
      onReady(m.token);
      break;
    }
    case "booterr": onError(new Error(m.message)); break;
    case "fetchres": {
      const p = pendingFetch.get(m.rid); if (!p) break; pendingFetch.delete(m.rid);
      p.resolve(new Response(m.body && m.body.byteLength ? m.body : null, { status: m.status, statusText: m.statusText, headers: new Headers(m.headers) }));
      break;
    }
    case "fetcherr": { const p = pendingFetch.get(m.rid); if (p) { pendingFetch.delete(m.rid); p.reject(new Error(m.message)); } break; }
    case "wsopened": { const s = liveSockets.get(m.sid); if (s) { s.readyState = WorkerSocket.OPEN; s._emit("open", { type: "open" }); } break; }
    case "wsmsg": { const s = liveSockets.get(m.sid); if (s) s._emit("message", { type: "message", data: m.data }); break; }
    case "wsclosed": { const s = liveSockets.get(m.sid); if (s) { s.readyState = WorkerSocket.CLOSED; s._emit("close", { type: "close", code: m.code, reason: m.reason }); liveSockets.delete(m.sid); } break; }
    case "wserr": { const s = liveSockets.get(m.sid); if (s) s._emit("error", { type: "error", data: m.message }); break; }
    case "egressout": egress?.send(m.frame); break; // carry the guest's frame to the extension
    case "apiok": (window as unknown as Record<string, unknown>).__HOLO_API_OK__ = m.ok; break;
    case "log": {
      // Surface worker/guest diagnostics to the browser console (prefixed so they're filterable).
      if (m.level === "guest") for (const line of m.msg.split("\n")) console.log("%c[hermes]", "color:#7c3aed", line);
      else if (m.level === "error") console.error("[holo]", m.msg);
      else if (m.level === "warn") console.warn("[holo]", m.msg);
      else console.info("[holo]", m.msg);
      break;
    }
  }
}

/** Boot the worker-hosted backend. Resolves once the in-guest token is adopted (the backend serves). */
export async function bootWorkerTransport(report: (p: HologramBootProgress) => void = () => {}): Promise<void> {
  const t0 = Date.now();
  // Beacon each phase to `window` (for tests/devtools) + forward to the boot UI.
  const onProgress = (p: HologramBootProgress) => {
    const w = window as unknown as Record<string, unknown>;
    w.__HOLO_BOOT_PHASE__ = p.phase;
    w.__HOLO_BOOT_DETAIL__ = p.detail ?? "";
    w.__HOLO_BOOT_ELAPSED__ = ((Date.now() - t0) / 1000).toFixed(1);
    report(p);
  };
  worker = new Worker(new URL("./holo-worker.ts", import.meta.url), { type: "module", name: "holospaces" });

  // Wire the agent's egress to the router extension if present (relay worker <-> extension).
  const extId = await awaitEgressExtensionId(1200);
  egress = extId ? connectEgress(extId) : null;
  egress?.onFrame((frame) => send({ t: "egressin", frame }, [frame.buffer]));

  await new Promise<void>((resolve, reject) => {
    worker!.onmessage = (ev: MessageEvent<FromWorker>) =>
      onWorkerMessage(ev, (token) => {
        // Install the worker transport (REST + WebSocket) + diagnostic hooks, then resolve.
        setFetchImpl(workerFetch as unknown as (url: string, init?: RequestInit) => Promise<Response>);
        setSocketFactory((url: string) => new WorkerSocket(guestRelativePath(url, HERMES_BASE_PATH)) as unknown as WebSocket);
        const w = window as unknown as Record<string, unknown>;
        w.__HOLO_BACKEND_READY__ = true;
        w.__HOLO_EGRESS_READY__ = !!egress;
        w.__HOLO_FETCH__ = (path: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
          return workerFetch(path, { ...init, headers });
        };
        w.__HOLO_WS__ = (path: string) => {
          const sep = path.includes("?") ? "&" : "?";
          return new WorkerSocket(guestRelativePath(`${path}${sep}token=${encodeURIComponent(token)}`, HERMES_BASE_PATH));
        };
        onProgress({ phase: "ready", detail: "in-browser backend live" });
        resolve();
      }, onProgress, reject);
    worker!.onerror = (e) => reject(new Error(`worker error: ${e.message}`));
    // OPFS disk paging is opt-in (?holo-resume=opfs): lower memory but currently slower than the
    // default monolithic resume. The default ships the proven, fast path.
    const opfs = typeof location !== "undefined" && new URLSearchParams(location.search).get("holo-resume") === "opfs";
    send({ t: "boot", base: HERMES_BASE_PATH, opfs });
  });
}

/** Tear down the worker transport (restore api.ts defaults). */
export function stopWorkerTransport(): void {
  resetTransport();
  worker?.terminate();
  worker = null;
}
