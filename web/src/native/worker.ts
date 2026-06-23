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
    case "wsopen":
      // The agent's PTY is the holospace process/terminal surface (G5/G6); not native yet — fail cleanly so
      // the dashboard degrades the chat rather than hanging.
      post({ t: "wserr", sid: msg.sid, message: "agent PTY pending the holospace process surface (G5)" });
      break;
    // wssend / wsclose / egressin are wired with the agent + egress increments (G6/G7).
    default:
      break;
  }
};

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
  const [manifest, sourceTar, osSurfacePy] = await Promise.all([
    fetchOk("deps.json").then((r) => r.json() as Promise<NativeManifest>),
    fetchOk("hermes-src.tar").then((r) => r.arrayBuffer()).then((x) => new Uint8Array(x)),
    fetchOk("os_surface.py").then((r) => r.text()),
  ]);

  progress("resume", "installing the real Hermes backend (native)");
  backend = await bootNativeBackend(py as never, {
    manifest, sourceTar, osSurfacePy,
    log: (m) => post({ t: "log", level: "info", msg: `[native] ${m}` }),
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
