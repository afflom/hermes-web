/// <reference lib="webworker" />
// holo-worker.ts — the holospaces data plane, hosted in a Web Worker. Everything heavy lives here: the
// wasm RISC-V emulator, fetching + verifying the warm-κ CAS, resuming the 1.44 GB machine, and the
// continuous BridgeRuntime pump that serves the dashboard's /api + WebSocket calls AND the agent's
// egress. Running off the main thread means the long resume never freezes the UI and the pump runs at
// full speed (no setTimeout throttling) so the in-guest Python answers far quicker.
//
// The worker can't reach the router extension (chrome.runtime is main-thread only), so egress frames are
// relayed: the worker posts guest frames out and feeds reply frames the main thread carries back.

import { loadWarmSnapshot, type WarmLoadProgress } from "./holo-cas";
import { BridgeRuntime, type HoloWorkspace, type RuntimeSocket } from "./holo-runtime";
import type { EgressChannel } from "./holo-egress";
import type { ToWorker, FromWorker } from "./holo-protocol";
import type { HologramBootProgress } from "./holo-hologram-types";

interface SyncAccessHandle {
  write(buf: Uint8Array, opts?: { at?: number }): number;
  truncate(n: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}
interface HsModule {
  default: (input?: unknown) => Promise<unknown>;
  kappa: (bytes: Uint8Array) => string;
  Workspace: {
    resume_devcontainer_net_bridged: (snapshot: Uint8Array) => HoloWorkspace;
    resume_devcontainer_net_bridged_streamed: (snapshot: SyncAccessHandle) => HoloWorkspace;
  };
}

/** Surface a diagnostic line to the main thread (→ browser console). */
function log(level: "info" | "warn" | "error" | "guest", msg: string) {
  post({ t: "log", level, msg });
}

/** Create a truncated OPFS sync access handle (worker-only) for `name`. */
async function opfsHandle(name: string): Promise<SyncAccessHandle> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const h = (await (fh as unknown as { createSyncAccessHandle: () => Promise<SyncAccessHandle> }).createSyncAccessHandle());
  h.truncate(0);
  return h;
}

const GUEST_PORT = 9119;
const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
const EMBEDDED_RE = /window\.__HERMES_DASHBOARD_EMBEDDED_CHAT__\s*=\s*(true|false)/;
const AUTH_RE = /window\.__HERMES_AUTH_REQUIRED__\s*=\s*(true|false)/;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
function post(msg: FromWorker, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}
function holoUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}holo/${rel}`.replace(/([^:])\/\//g, "$1/");
}

let runtime: BridgeRuntime | null = null;
let egressInbound: ((f: Uint8Array) => void) | null = null;
const sockets = new Map<number, RuntimeSocket>();

async function boot(_useOpfs: boolean): Promise<void> {
  const report = (p: HologramBootProgress) => post({ t: "progress", p });
  const t0 = performance.now();
  const since = (mark: number) => `${((performance.now() - mark) / 1000).toFixed(1)}s`;

  report({ phase: "wasm", detail: "loading the holospaces runtime" });
  const hs = (await import(/* @vite-ignore */ holoUrl("holospaces_web.js"))) as HsModule;
  await hs.default();
  log("info", `wasm runtime loaded (${since(t0)})`);

  report({ phase: "snapshot", detail: "fetching the warm Hermes machine" });
  const tSnap = performance.now();
  let snapshot = await loadWarmSnapshot(
    (b) => hs.kappa(b),
    (p: WarmLoadProgress) =>
      report({ phase: p.phase === "verify" || p.phase === "persist" ? "resume" : "snapshot", detail: p.detail, fraction: p.fraction }),
  );
  log("info", `warm machine loaded + verified, ${(snapshot.length / 1e6).toFixed(0)} MB (${since(tSnap)})`);

  // DEFAULT resume = STREAMED into an in-wasm MemKappaStore: stage the snapshot in OPFS, FREE the JS
  // copy, then resume by streaming it back — so the wasm heap never holds the 1.44 GB snapshot copy
  // (the ~2.7 GB monolithic peak that aborts on refresh). The disk stays in-wasm, so serving is full
  // speed. Falls back to the monolithic in-heap resume only if OPFS sync handles are unavailable.
  let ws: HoloWorkspace;
  let snap: SyncAccessHandle | null = null;
  try {
    snap = await opfsHandle("holo-snapshot.bin");
  } catch (e) {
    log("warn", `OPFS sync handles unavailable — falling back to in-heap resume: ${e}`);
  }
  const tResume = performance.now();
  if (snap) {
    report({ phase: "disk", detail: "staging the warm machine in local storage" });
    for (let off = 0; off < snapshot.length; off += 64 * 1024 * 1024) {
      snap.write(snapshot.subarray(off, Math.min(off + 64 * 1024 * 1024, snapshot.length)), { at: off });
    }
    snap.flush();
    snapshot = new Uint8Array(0); // free the 1.44 GB JS copy BEFORE the resume (it lives in OPFS now)
    report({ phase: "resume", detail: "resuming the warm machine (low-memory streamed)" });
    ws = hs.Workspace.resume_devcontainer_net_bridged_streamed(snap);
    snap.close();
    (await navigator.storage.getDirectory()).removeEntry("holo-snapshot.bin").catch(() => {});
    log("info", `resumed (streamed, low-peak) in ${since(tResume)}`);
  } else {
    report({ phase: "resume", detail: "resuming the warm machine (no cold boot)" });
    ws = hs.Workspace.resume_devcontainer_net_bridged(snapshot);
    log("info", `resumed (monolithic in-heap) in ${since(tResume)}`);
  }

  // Egress proxy: the worker can't open sockets, so it relays frames to/from the main thread.
  const egress: EgressChannel = {
    send: (frame) => post({ t: "egressout", frame }, [frame.buffer]),
    onFrame: (cb) => { egressInbound = cb; },
    close: () => {},
  };

  report({ phase: "attach", detail: "re-attaching the loopback transport" });
  runtime = new BridgeRuntime(ws, { port: GUEST_PORT, egress });
  runtime.start();
  startConsoleRelay(runtime); // surface the in-guest server/agent logs to the browser console

  report({ phase: "token", detail: "authenticating with the in-guest server" });
  const token = await adoptToken(runtime);
  log("info", `in-guest server authenticated; ready in ${since(t0)} total`);
  post({ t: "ready", token: token.token, embedded: token.embedded, authRequired: token.authRequired });

  // Background: confirm a protected /api route answers (the in-guest Python, not just the static SPA).
  runtime
    .fetch("/api/status", { headers: { authorization: `Bearer ${token.token}` } })
    .then((r) => { log(r.ok ? "info" : "warn", `/api/status → ${r.status}`); post({ t: "apiok", ok: r.ok }); })
    .catch((e) => { log("error", `/api/status failed: ${e}`); post({ t: "apiok", ok: false }); });
}

/** Poll the guest console and relay new output to the main thread (→ browser console). */
function startConsoleRelay(rt: BridgeRuntime): void {
  let carry = "";
  setInterval(() => {
    const delta = rt.consoleDelta();
    if (!delta) return;
    carry += delta;
    const nl = carry.lastIndexOf("\n");
    if (nl < 0) return;
    const out = carry.slice(0, nl);
    carry = carry.slice(nl + 1);
    if (out.trim()) log("guest", out);
  }, 1000);
}

async function adoptToken(rt: BridgeRuntime): Promise<{ token: string; embedded: boolean; authRequired: boolean }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const res = await rt.fetch("/", { headers: { accept: "text/html" } });
      const html = await res.text();
      const m = html.match(TOKEN_RE);
      if (m) {
        const em = html.match(EMBEDDED_RE);
        const au = html.match(AUTH_RE);
        return { token: m[1], embedded: em ? em[1] === "true" : true, authRequired: au ? au[1] === "true" : false };
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`in-guest dashboard never served a session token${lastErr ? `: ${lastErr}` : ""}`);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.t) {
    case "boot":
      boot(msg.opfs).catch((e) => post({ t: "booterr", message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }));
      break;
    case "fetch": {
      if (!runtime) return post({ t: "fetcherr", rid: msg.rid, message: "runtime not ready" });
      runtime
        .fetch(msg.path, { method: msg.method, headers: msg.headers, body: msg.body })
        .then(async (res) => {
          const body = await res.arrayBuffer();
          post(
            { t: "fetchres", rid: msg.rid, status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body },
            [body],
          );
        })
        .catch((e) => post({ t: "fetcherr", rid: msg.rid, message: e instanceof Error ? e.message : String(e) }));
      break;
    }
    case "wsopen": {
      if (!runtime) return post({ t: "wserr", sid: msg.sid, message: "runtime not ready" });
      try {
        const sock = runtime.openSocket(msg.path);
        sockets.set(msg.sid, sock);
        sock.binaryType = "arraybuffer";
        sock.addEventListener("open", () => post({ t: "wsopened", sid: msg.sid }));
        sock.addEventListener("message", (e: { data?: unknown }) => {
          const data = e.data as string | ArrayBuffer;
          post({ t: "wsmsg", sid: msg.sid, data }, data instanceof ArrayBuffer ? [data] : []);
        });
        sock.addEventListener("close", (e: { code?: number; reason?: string }) =>
          post({ t: "wsclosed", sid: msg.sid, code: e.code ?? 1000, reason: e.reason ?? "" }),
        );
        sock.addEventListener("error", (e: { data?: unknown }) => post({ t: "wserr", sid: msg.sid, message: String(e.data ?? "ws error") }));
      } catch (e) {
        post({ t: "wserr", sid: msg.sid, message: e instanceof Error ? e.message : String(e) });
      }
      break;
    }
    case "wssend":
      sockets.get(msg.sid)?.send(msg.binary ? new Uint8Array(msg.data as ArrayBuffer) : (msg.data as string));
      break;
    case "wsclose":
      sockets.get(msg.sid)?.close();
      sockets.delete(msg.sid);
      break;
    case "egressin":
      egressInbound?.(msg.frame);
      break;
  }
};
