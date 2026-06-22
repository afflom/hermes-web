/// <reference lib="webworker" />
// holo-worker.ts — the holospaces data plane, hosted in a Web Worker. Everything heavy lives here: the
// wasm RISC-V emulator, fetching + verifying the warm-κ CAS, resuming the 1.44 GB machine, and the
// continuous BridgeRuntime pump that serves the dashboard's /api + WebSocket calls AND the agent's
// egress. Running off the main thread means the long resume never freezes the UI and the pump runs at
// full speed (no setTimeout throttling) so the in-guest Python answers far quicker.
//
// The worker can't reach the router extension (chrome.runtime is main-thread only), so egress frames are
// relayed: the worker posts guest frames out and feeds reply frames the main thread carries back.

import { ungzip } from "pako";
import { loadWarmChunks, loadWarmResponses, type WarmLoadProgress } from "./holo-cas";
import { BridgeRuntime, type HoloWorkspace, type RuntimeSocket } from "./holo-runtime";
import type { EgressChannel } from "./holo-egress";
import type { ToWorker, FromWorker } from "./holo-protocol";
import type { HologramBootProgress } from "./holo-hologram-types";

declare const __HOLO_ASSET_VER__: string; // build-time content hash of the wasm + glue (vite define)

interface HsModule {
  default: (input?: unknown) => Promise<unknown>;
  kappa: (bytes: Uint8Array) => string;
  Workspace: {
    resume_devcontainer_net_bridged: (snapshot: Uint8Array) => HoloWorkspace;
    resume_devcontainer_net_bridged_fed: (next: () => Uint8Array) => HoloWorkspace;
    resume_devcontainer_net_bridged_fed_opfs: (
      next: () => Uint8Array,
      diskHandle: FileSystemSyncAccessHandle,
    ) => HoloWorkspace;
  };
}

/** Open a fresh, empty OPFS sync access handle for the off-heap disk κ-store (worker-only API). Each boot
 * starts from a truncated file so the κ→offset index the store builds matches the bytes on disk. No
 * fallback: if OPFS sync handles are unavailable we fail loud rather than silently fall back to an in-heap
 * disk (which is the ~3.3 GB peak we are eliminating). */
async function openDiskHandle(): Promise<FileSystemSyncAccessHandle> {
  const root = await navigator.storage.getDirectory();
  // Drop any stale disk from a previous boot, then create + open fresh.
  try {
    await root.removeEntry("hermes-disk.kstore");
  } catch {
    /* absent is fine */
  }
  const fh = await root.getFileHandle("hermes-disk.kstore", { create: true });
  const handle = await fh.createSyncAccessHandle();
  handle.truncate(0); // belt-and-suspenders: the store appends from offset 0
  return handle;
}

/** Surface a diagnostic line to the main thread (→ browser console). */
function log(level: "info" | "warn" | "error" | "guest", msg: string) {
  post({ t: "log", level, msg });
}

// ── Bridge response cache (k-theoretic memoization at the seam) ──────────────────────────────────────
// The in-guest server is multi-second per request under interpretation, and the dashboard re-fetches the
// same idempotent GETs constantly (sidebar status polling, re-renders, navigating back to a view). Collapse
// those: an in-flight GET is shared by all concurrent callers (dedup), and a completed GET is reused for a
// short TTL — so a poll storm runs the guest ONCE, not N times. Any mutating request clears the cache so
// reads-after-writes stay correct; the short TTL bounds staleness for everything else.
const CACHE_TTL_MS = 3000;
// A few read handlers gather live data on EVERY call; the in-flight dedup collapses concurrent polls and a
// 30 s TTL keeps the dashboard's *periodic* polls from each re-paying. /api/status is special-cased below.
const SLOW_TTL_MS = 30_000;
const SLOW_GET = /\/api\/(system\/stats|model\/options|analytics)/;
// k-aligned seed: GETs whose responses were captured from the warm κ at bank time (warm-responses.json).
// They are served from the content-addressed seed and held for a long TTL — the dashboard reads the κ
// instantly, never round-tripping the (serialized, single-connection) guest for a read it already computed.
const SEED_TTL_MS = 600_000; // 10 min — effectively the session; long enough that the lane is never the read path
const seededPaths = new Set<string>();
const ttlFor = (path: string): number =>
  seededPaths.has(path) ? SEED_TTL_MS : SLOW_GET.test(path) ? SLOW_TTL_MS : CACHE_TTL_MS;
interface CachedRes { status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer }
const fetchCache = new Map<string, { res: Promise<CachedRes>; done: boolean; at: number }>();

/** Seed the read cache from the warm κ's bank-captured responses (the k-aligned dashboard fast path). */
function seedReadCache(responses: Record<string, { status: number; ct: string; body: string }>): number {
  let n = 0;
  for (const [path, r] of Object.entries(responses)) {
    const hex = r.body || "";
    const buf = new Uint8Array(hex.length / 2);
    for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
    const res: CachedRes = { status: r.status, statusText: "OK", headers: [["content-type", r.ct || "application/json"]], body: buf.buffer };
    if (path.split("?")[0] === STATUS_PATH) {
      // /api/status is served by serveStatus() from its own cache, not fetchCache. Seed it so the dashboard
      // reads the κ status instantly (200) instead of 503-until-idle-refresh; the refresher keeps it live.
      statusCache = res;
      statusAt = Date.now();
    } else {
      fetchCache.set(path, { res: Promise.resolve(res), done: true, at: Date.now() });
      seededPaths.add(path);
    }
    n++;
  }
  return n;
}

// ── egress-prober gate ───────────────────────────────────────────────────────────────────────────────
// These endpoints reach OUTBOUND (LLM providers, the skills hub, MCP/messaging connectivity probes). Their
// in-guest handler BLOCKS on a network reply; with no router extension wired that reply never comes, and the
// stuck handler holds the guest's single serving slot — poisoning every later loopback read. So when egress
// is absent we answer them a fast 503 here, never dialing the guest. With the extension present they pass
// through normally. (The dashboard treats the 503 as "unavailable" and shows the install nudge.)
// `hermes/update` (check + apply) probes GitHub for a newer release — an outbound call with the same
// single-slot-poisoning hazard, so it fast-503s without the router too (the dashboard shows "update
// unavailable", correct offline). All other dashboard reads are LOCAL and served instantly from the warm seed.
const EGRESS_PROBE = /^\/api\/(model\/(info|options|set|auxiliary)|skills|mcp\/|mcp$|messaging\/|hermes\/update)/;
let egressAvailable = false;
const egressUnavailableRes = (): Promise<CachedRes> =>
  Promise.resolve({ status: 503, statusText: "router extension required", headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode('{"detail":"the holospaces router extension is required for network access"}').buffer as ArrayBuffer });

// ── k-aligned /api/status ─────────────────────────────────────────────────────────────────────────────
// The in-guest /api/status re-gathers live system metrics on EVERY call (~100 s under emulation) and is
// CPU-bound, so it BLOCKS the guest's single-threaded asyncio loop and starves every other request. The
// only correct shape is to operate over the content-addressed (cached) representation: serve a CACHED
// status κ instantly on the request path, and re-derive it ONLY when the loop is otherwise idle. The
// dashboard reads the κ; the heavy compute never blocks a real request. The sidebar treats a not-yet-warm
// status as "loading" (useSidebarStatus swallows the error), so a 503 before the first idle refresh is fine.
const STATUS_PATH = "/api/status";
let statusCache: CachedRes | null = null;
let statusAt = 0;
let statusRefreshing = false;
let statusToken = "";
const STATUS_STALE_MS = 15_000;
function serveStatus(): Promise<CachedRes> {
  if (statusCache) return Promise.resolve(statusCache);
  return Promise.resolve({ status: 503, statusText: "status warming", headers: [["retry-after", "3"]], body: new ArrayBuffer(0) });
}
// Re-derive the status κ only after the loop has been idle for SUSTAINED time. Its ~100 s compute can't be
// preempted (single-threaded guest), so we must not start it during the brief idle right after `ready`
// (the dashboard's mount burst is about to arrive) or in the gaps between a page's fetches — any of those
// would let the blocking compute starve a real request. Several consecutive idle checks ≈ the dashboard
// is genuinely quiescent; only then is it safe.
let statusIdleStreak = 0;
const STATUS_IDLE_REQUIRED = 5; // × 2.5 s ≈ 12.5 s of sustained quiet before the blocking re-derive
function refreshStatusWhenIdle(): void {
  if (statusRefreshing || !runtime || !statusToken) return;
  if (statusCache && Date.now() - statusAt < STATUS_STALE_MS) { statusIdleStreak = 0; return; }
  if (runtime.metrics().fetchesInFlight > 0) { statusIdleStreak = 0; return; } // a real request owns the loop
  if (++statusIdleStreak < STATUS_IDLE_REQUIRED) return; // not yet sustained-idle — wait
  statusIdleStreak = 0;
  statusRefreshing = true;
  runGuestFetch({ path: STATUS_PATH, method: "GET", headers: { authorization: `Bearer ${statusToken}` }, timeoutMs: 220_000 })
    .then((res) => { statusCache = res; statusAt = Date.now(); })
    .catch(() => {})
    .finally(() => { statusRefreshing = false; });
}

// SINGLE-LANE guest fetch. The in-guest server serves exactly ONE loopback connection at a time (proven
// natively: a pool of 1 serves 10/10 requests, a pool of 3 serves 1/10 — 2+ concurrent sockets stall the
// guest's single-threaded accept/serve loop). The browser dashboard, however, fires ~10 fetches at once on
// mount. So we serialize: every guest fetch chains behind the previous, dialing the next only once the
// current connection has closed. Cache HITS in serveGuestFetch bypass this lane (no dial), so warm
// repeat-polls stay instant; only genuine round-trips queue.
let fetchLane: Promise<unknown> = Promise.resolve();
function runGuestFetch(msg: { path: string; method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<CachedRes> {
  const run = fetchLane.then(() => {
    const t = performance.now();
    log("info", `→ guest ${msg.method} ${msg.path}`);
    return runtime!
      .fetch(msg.path, { method: msg.method, headers: msg.headers, body: msg.body, holoTimeoutMs: msg.timeoutMs } as RequestInit)
      .then(async (res) => {
        log("info", `← guest ${msg.path} → ${res.status} in ${Math.round(performance.now() - t)}ms`);
        return { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()] as [string, string][], body: await res.arrayBuffer() };
      });
  });
  fetchLane = run.then(() => {}, () => {}); // the next fetch waits for this one to settle, success or not
  return run;
}

function serveGuestFetch(msg: { path: string; method: string; headers: Record<string, string>; body?: string }): Promise<CachedRes> {
  const bare = msg.path.split("?")[0];
  // Egress-prober with no gateway → fast 503, never dialing the guest (so its handler can't stall the slot).
  if (!egressAvailable && EGRESS_PROBE.test(bare)) return egressUnavailableRes();
  const isGet = (msg.method || "GET").toUpperCase() === "GET";
  // /api/status: NEVER fetch synchronously — answer from the cached κ; the idle refresher re-derives it.
  if (isGet && bare === STATUS_PATH) return serveStatus();
  if (!isGet) {
    fetchCache.clear(); // a mutation can change any read
    return runGuestFetch(msg);
  }
  const key = msg.path;
  const hit = fetchCache.get(key);
  if (hit && (!hit.done || Date.now() - hit.at < ttlFor(key))) return hit.res;
  const entry = { res: runGuestFetch(msg), done: false, at: Date.now() };
  fetchCache.set(key, entry);
  entry.res.then(() => { entry.done = true; entry.at = Date.now(); }, () => fetchCache.delete(key));
  return entry.res;
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

async function boot(_useOpfs: boolean, diagMode?: string, egressIsAvailable = false): Promise<void> {
  egressAvailable = egressIsAvailable;
  const report = (p: HologramBootProgress) => post({ t: "progress", p });
  const t0 = performance.now();
  const since = (mark: number) => `${((performance.now() - mark) / 1000).toFixed(1)}s`;

  report({ phase: "wasm", detail: "loading the holospaces runtime" });
  // Cache-bust the stable-URL wasm + glue by their build-time content hash: a returning browser otherwise
  // loads a STALE cached runtime against the new worker → boot crash. Version the glue import AND pass the
  // versioned wasm URL explicitly (wasm-bindgen's default wasm URL drops the glue's query, so it must be
  // passed). Static hosting (Pages) ignores the query and serves the file.
  const av = typeof __HOLO_ASSET_VER__ !== "undefined" && __HOLO_ASSET_VER__ ? `?v=${__HOLO_ASSET_VER__}` : "";
  const hs = (await import(/* @vite-ignore */ holoUrl("holospaces_web.js") + av)) as HsModule;
  // hs.default() returns the wasm exports — keep them so the boot can sample the wasm linear-memory size
  // (the real footprint, alongside the JS bytes held) and gate the peak.
  const wasmExports = (await hs.default(av ? holoUrl("holospaces_web_bg.wasm") + av : undefined)) as { memory: WebAssembly.Memory };
  const wasmBytes = (): number => wasmExports?.memory?.buffer?.byteLength ?? 0;
  log("info", `wasm runtime loaded (${since(t0)})`);

  // STREAMING low-peak load: fetch the COMPRESSED chunks (~390 MB total, never the 1.9 GB of raw) + verify
  // the κ incrementally (JS blake3, no wasm verify-copy). See holo-cas.loadWarmChunks.
  report({ phase: "snapshot", detail: "fetching the warm Hermes machine" });
  const tSnap = performance.now();
  const { gz, gzip, total } = await loadWarmChunks(
    (p: WarmLoadProgress) =>
      report({ phase: p.phase === "verify" ? "resume" : "snapshot", detail: p.detail, fraction: p.fraction }),
  );
  log("info", `warm machine fetched + verified, ${(total / 1e6).toFixed(0)} MB (${since(tSnap)})`);

  // Resume = FED, fed window-by-window. Each compressed chunk is INFLATED on demand (one at a time) and
  // freed once consumed, so the JS side holds only the shrinking compressed array (~390 MB) plus one raw
  // chunk (~50 MB) — never the whole 1.9 GB. The wasm heap grows to the machine size (~1.85 GB) as the disk
  // is fed; they never coexist at full size → peak ~1.9 GB (the machine floor), not ~3.3 GB. We sample
  // (live JS bytes + wasm memory) on each window so the true peak is measured and gated (deployment.spec).
  report({ phase: "resume", detail: "resuming the warm machine (no cold boot)" });
  const tResume = performance.now();
  // Open the off-heap disk κ-store BEFORE feeding: the disk's content-addressed sectors page into OPFS as
  // the snapshot streams, so they never land on the wasm heap. Combined with the SPARSE κ (no dense zero
  // free-space), the wasm heap holds only RAM + the sparse indices → resume peaks well under 1.5 GB.
  const diskHandle = await openDiskHandle();
  let ws: HoloWorkspace;
  const FEED = 16 * 1024 * 1024;
  let ci = 0;
  let cOff = 0;
  let curRaw: Uint8Array | null = null; // the currently-inflated chunk
  let peakBytes = 0;
  const sample = (): void => {
    let live = curRaw?.length ?? 0;
    for (let i = ci; i < gz.length; i++) live += gz[i]?.length ?? 0;
    const tot = live + wasmBytes();
    if (tot > peakBytes) peakBytes = tot;
  };
  sample(); // pre-resume baseline (compressed array + wasm base)
  const next = (): Uint8Array => {
    for (;;) {
      if (curRaw === null) {
        if (ci >= gz.length) return new Uint8Array(0); // EOF
        const comp = gz[ci]!;
        curRaw = gzip ? ungzip(comp) : comp; // inflate this chunk on demand
        gz[ci] = null; // free the compressed bytes now that we've inflated them
        cOff = 0;
      }
      if (cOff < curRaw.length) break;
      curRaw = null; // current chunk fully fed → drop it, advance
      ci++;
    }
    const end = Math.min(cOff + FEED, curRaw.length);
    const win = curRaw.subarray(cOff, end); // a view; the fed resume copies it in
    cOff = end;
    sample();
    return win;
  };
  ws = hs.Workspace.resume_devcontainer_net_bridged_fed_opfs(next, diskHandle);
  for (let i = 0; i < gz.length; i++) gz[i] = null; // ensure everything is freed
  log("info", `resumed (streamed-fed) in ${since(tResume)}, peak ${(peakBytes / 1e6).toFixed(0)} MB`);
  post({ t: "peakbytes", bytes: peakBytes });

  // DIFFERENTIAL DIAGNOSTIC (?holo-diag=digests): emit the wasm side of the native↔wasm equivalence
  // harness. Same restored machine + same loopback input + same per-step budget MUST yield the same full
  // snapshot digest at each checkpoint as the native witness (cc_warm_divergence). The first checkpoint
  // whose digest differs localizes the wasm-vs-native divergence behind the warm-κ spin. Raw dial/send/run
  // (no BridgeRuntime, no recv) so the op sequence is byte-identical to the native test. Keep checkpoints
  // + request bytes IN SYNC with cc_hermes_guest.rs. Halts here (no serve) — the gate logs then times out.
  if (diagMode === "digests") {
    const PUMP_BUDGET = 8_000_000, TICKS = 12; // exactly the BridgeRuntime cadence; ~96M instr
    const req = new TextEncoder().encode("GET / HTTP/1.1\r\nHost: guest\r\nConnection: close\r\naccept: text/html\r\n\r\n");
    log("info", `DIVERGE wasm D0 (post-restore) = ${ws.state_digest()}`);
    const id = ws.dial_guest(GUEST_PORT);
    if (id == null) { log("error", "DIVERGE: dial :9119 failed"); return; }
    ws.guest_send(id, req);
    let at = 0, resp = 0;
    for (let t = 0; t < TICKS; t++) {
      ws.run(PUMP_BUDGET); at += PUMP_BUDGET;
      for (let f = ws.egress_outbound(); f != null; f = ws.egress_outbound()) { /* drain */ }
      resp += ws.guest_recv(id).length; // replicate the BridgeRuntime tick exactly (drain TX)
      log("info", `DIVERGE wasm D@${at} = ${ws.state_digest()} (open=${ws.guest_is_open(id)}, resp=${resp}B)`);
    }
    log("info", "DIVERGE wasm done");
    return; // do not start the BridgeRuntime — this run is purely the digest probe
  }

  // SETTLE the resumed machine before the first request. Even though the κ is banked pre-settled, the
  // resume re-attaches egress + re-enables the loopback ingress AFTER restore, which perturbs the net/loop
  // state — so the machine must re-quiesce here, post-resume. A request that arrives before that spins the
  // guest forever instead of serving (proven by the differential native↔wasm harness — identical in both,
  // a substrate behaviour, not a wasm bug; native sweep: <50M instr spins, ≥100M serves). Run idle with NO
  // request in flight, then every endpoint serves warm. One-time, ~25s; the heavier 22-endpoint κ uses a
  // generous budget so it reliably reaches ready.
  report({ phase: "settle", detail: "letting the resumed server re-establish" });
  const tSettle = performance.now();
  const SETTLE_INSTRUCTIONS = 320_000_000;
  for (let done = 0; done < SETTLE_INSTRUCTIONS; done += 8_000_000) ws.run(8_000_000);
  log("info", `settled the resumed server in ${since(tSettle)}`);

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
  // Diagnostic: while authenticating, surface the pump state so a hung auth shows whether the interpreter
  // is advancing (pump alive, guest not responding) or stalled (pump stuck).
  let lastRun = 0;
  const authDiag = setInterval(() => {
    const m = runtime!.metrics();
    log("info", `auth wait: pump ${m.ticks} ticks, ${m.runMs}ms cpu (+${m.runMs - lastRun}ms), ${m.fetchesInFlight} in-flight`);
    lastRun = m.runMs;
  }, 4000);
  const token = await adoptToken(runtime).finally(() => clearInterval(authDiag));
  log("info", `in-guest server authenticated; ready in ${since(t0)} total`);

  // k-aligned read seed: serve the dashboard's reads from the warm κ's bank-captured responses. Seed BEFORE
  // `ready` so the dashboard's ~10-fetch mount burst hits the content-addressed cache (instant) instead of
  // the serialized single-connection guest. Without it the mount round-trips the guest at ~2-3 s/read and
  // starves on the one-connection-at-a-time lane.
  const warmResponses = await loadWarmResponses();
  if (warmResponses) log("info", `seeded ${seedReadCache(warmResponses)} dashboard reads from the warm κ`);
  else log("warn", "no warm-responses.json — dashboard reads will round-trip the guest (slow)");

  // k-aligned /api/status: hand the idle refresher the session token and let it re-derive the status κ
  // only in idle gaps (checked frequently, runs rarely). The dashboard always reads the cached κ.
  statusToken = token.token;
  setInterval(refreshStatusWhenIdle, 2500);
  post({ t: "ready", token: token.token, embedded: token.embedded, authRequired: token.authRequired });

  // Background: confirm a protected /api route answers (the in-guest Python, not just the static SPA). Use
  // a LIGHT warm endpoint (/api/config) — NOT /api/status. CRITICAL: go through runGuestFetch (the single
  // lane), NOT runtime.fetch directly — a direct fetch would race the dashboard's mount fetches as a 2nd
  // concurrent connection, and the guest serves only ONE at a time, so both would stall.
  runGuestFetch({ path: "/api/config", method: "GET", headers: { authorization: `Bearer ${token.token}` } })
    .then((r) => { const ok = r.status >= 200 && r.status < 300; log(ok ? "info" : "warn", `/api/config → ${r.status}`); post({ t: "apiok", ok }); })
    .catch((e) => { log("error", `/api/config failed: ${e}`); post({ t: "apiok", ok: false }); });
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
      if (attempt < 3 || m) log("info", `auth attempt ${attempt + 1}: / → ${html.length}B, token=${!!m}`);
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
      boot(msg.opfs, msg.diag, msg.egressAvailable).catch((e) => post({ t: "booterr", message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }));
      break;
    case "fetch": {
      if (!runtime) return post({ t: "fetcherr", rid: msg.rid, message: "runtime not ready" });
      const t0 = performance.now();
      serveGuestFetch(msg)
        .then((r) => {
          const ms = performance.now() - t0;
          if (ms > 1500) log("info", `${msg.method} ${msg.path} → ${r.status} (${(ms / 1000).toFixed(1)}s)`);
          const body = r.body.slice(0); // a transferable copy; the cache keeps the original
          post({ t: "fetchres", rid: msg.rid, status: r.status, statusText: r.statusText, headers: r.headers, body }, [body]);
        })
        .catch((e) => post({ t: "fetcherr", rid: msg.rid, message: e instanceof Error ? e.message : String(e) }));
      break;
    }
    case "capraw": {
      // Seed-capture only: dial the guest DIRECTLY (bypass the seed, the /api/status short-circuit, and the
      // egress gate) so we record the guest's true response (e.g. /api/status → 200, not the uncached 503).
      if (!runtime) return post({ t: "fetcherr", rid: msg.rid, message: "runtime not ready" });
      runGuestFetch({ path: msg.path, method: "GET", headers: msg.headers ?? {}, timeoutMs: 240_000 })
        .then((r) => {
          const body = r.body.slice(0);
          post({ t: "fetchres", rid: msg.rid, status: r.status, statusText: r.statusText, headers: r.headers, body }, [body]);
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
