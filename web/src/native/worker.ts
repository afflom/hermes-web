/// <reference lib="webworker" />
// The native-exec backend worker — the hologram-native replacement for holo-worker's emulated guest. It boots
// Pyodide on the browser peer's own JS engine, loads the REAL Hermes Python (the bundle) + the OS-surface
// adapter, and serves /api in-process. It speaks the EXACT holo-protocol the main thread already uses, so
// holo-client + the whole dashboard are unchanged (DRY) — only the data-plane backend swaps.

import { loadPyodide } from "pyodide";
import { bootNativeBackend, type NativeBackend, type NativeManifest } from "./runtime";
import type { ToWorker, FromWorker } from "../lib/holo-protocol";

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer?: Transferable[]) => ctx.postMessage(m, transfer ?? []);
const progress = (phase: string, detail: string) => post({ t: "progress", p: { phase, detail } as never });

let backend: NativeBackend | null = null;

// The dashboard's WS sids map onto the backend's ASGI-WS driver sids (both directions: send/close look up the
// native sid by protocol sid; the driver's events look up the protocol sid by native sid).
const sockets = new Map<number, number>(); // protocolSid → nativeSid
const byNative = new Map<number, number>(); // nativeSid → protocolSid
// Outbound HTTPS the agent's LLM call makes: each httpfetch is awaited on the main thread (the only place
// chrome.runtime lives) and resolved here by fid when httpfetchres returns.
let nextFid = 1;
const pendingHttp = new Map<number, (r: { status: number; headers: [string, string][]; body: ArrayBuffer; error?: string }) => void>();

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.t) {
    case "boot":
      boot().catch((err) => post({ t: "booterr", message: String(err?.stack ?? err) }));
      break;
    case "fetch":
      serve(msg.rid, msg.method, msg.path, msg.headers, msg.body);
      break;
    case "capraw":
      serve(msg.rid, "GET", msg.path, msg.headers ?? {}, undefined);
      break;
    case "wsopen": {
      // The agent gateway runs NATIVE (the cooperative thread surface), so the chat WS is served in-process by
      // the ASGI WebSocket driver — no PTY, no emulator.
      if (!backend) { post({ t: "wserr", sid: msg.sid, message: "native backend not ready" }); break; }
      const nativeSid = backend.openSocket(msg.path);
      sockets.set(msg.sid, nativeSid);
      byNative.set(nativeSid, msg.sid);
      break;
    }
    case "wssend": {
      const nativeSid = sockets.get(msg.sid);
      if (nativeSid != null && backend) backend.sendSocket(nativeSid, typeof msg.data === "string" ? msg.data : new TextDecoder().decode(msg.data));
      break;
    }
    case "wsclose": {
      const nativeSid = sockets.get(msg.sid);
      if (nativeSid != null && backend) backend.closeSocket(nativeSid);
      sockets.delete(msg.sid);
      break;
    }
    case "httpfetchres": {
      const resolve = pendingHttp.get(msg.fid);
      if (resolve) { pendingHttp.delete(msg.fid); resolve(msg); }
      break;
    }
    default:
      break;
  }
};

// host.fetch — the agent's outbound HTTPS (the LLM call). The worker can't reach chrome.runtime, so it asks the
// main thread to perform the request via the extension's CORS-free fetch; run_sync (in the runtime) suspends the
// wasm stack until httpfetchres returns. Returns [status, headers, bodyBytes] for the Python httpx transport.
function hostFetch(method: string, url: string, headers: [string, string][], body: Uint8Array): Promise<[number, [string, string][], Uint8Array]> {
  const fid = nextFid++;
  const buf = body && body.byteLength ? (body.slice().buffer as ArrayBuffer) : new ArrayBuffer(0);
  return new Promise((resolve) => {
    pendingHttp.set(fid, (r) => resolve([r.status, r.headers, new Uint8Array(r.body)]));
    post({ t: "httpfetch", fid, method, url, headers, body: buf }, [buf]);
  });
}

// Base-aware native-asset URL — same vite BASE_URL the (working) κ fetch uses, NOT the boot message.
function nativeUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}native/${rel}`.replace(/([^:])\/\//g, "$1/");
}
async function fetchOk(rel: string): Promise<Response> {
  const r = await fetch(nativeUrl(rel));
  if (!r.ok) throw new Error(`native asset ${rel} → ${r.status} (build did not ship web/public/native?)`);
  return r;
}

async function boot(): Promise<void> {
  const t0 = Date.now();
  progress("runtime", "loading the native runtime (Pyodide)");
  const py = await loadPyodide({ indexURL: PYODIDE_CDN, stdout: () => {}, stderr: () => {} });

  progress("snapshot", "fetching the Hermes backend");
  const [manifest, sourceTar, osSurfacePy, osNetPy] = await Promise.all([
    fetchOk("deps.json").then((r) => r.json() as Promise<NativeManifest>),
    fetchOk("hermes-src.tar").then((r) => r.arrayBuffer()).then((x) => new Uint8Array(x)),
    fetchOk("os_surface.py").then((r) => r.text()),
    fetchOk("os_net.py").then((r) => r.text()),
  ]);

  progress("resume", "installing the real Hermes backend (native)");
  backend = await bootNativeBackend(py as never, {
    manifest, sourceTar, osSurfacePy, osNetPy,
    // The agent's outbound HTTPS rides the egress (the LLM call); host.fetch returns a Promise the runtime
    // suspends on with run_sync (JSPI). The native gateway's threads run on the cooperative thread surface.
    host: { fetch: hostFetch as never },
    log: (m) => post({ t: "log", level: "info", msg: `[native] ${m}` }),
  });

  // Relay the ASGI-WS driver's events back to the dashboard over the holo-protocol (native sid → protocol sid).
  backend.onSocketEvent((ev) => {
    const psid = byNative.get(ev.sid);
    if (psid == null) return;
    if (ev.kind === "accept") post({ t: "wsopened", sid: psid });
    else if (ev.kind === "message") post({ t: "wsmsg", sid: psid, data: ev.data });
    else if (ev.kind === "close") { post({ t: "wsclosed", sid: psid, code: ev.code, reason: ev.data }); byNative.delete(ev.sid); }
    else if (ev.kind === "error") post({ t: "wserr", sid: psid, message: ev.data });
  });

  post({ t: "log", level: "info", msg: `[native] backend ready in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
  post({ t: "ready", token: backend.token, embedded: true, authRequired: false });
}

async function serve(rid: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<void> {
  if (!backend) return post({ t: "fetcherr", rid, message: "native backend not ready" });
  try {
    const bodyBytes = body != null ? new TextEncoder().encode(body) : null;
    const r = await backend.request(method, path, headers, bodyBytes);
    const buf = r.body.byteLength
      ? r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength)
      : null;
    post({ t: "fetchres", rid, status: r.status, statusText: "OK", headers: r.headers, body: buf }, buf ? [buf] : []);
  } catch (e) {
    post({ t: "fetcherr", rid, message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
  }
}
