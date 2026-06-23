// The native-exec Hermes backend runtime — DRY, env-agnostic (node-testable, browser-deployable). Given a
// Pyodide instance + the build artifacts (deps.json, hermes-src.tar, os_surface.py), it installs the deps,
// unpacks the REAL Hermes Python, applies the single OS-surface adapter, and serves the real FastAPI app
// in-process (httpx ASGITransport). The caller (worker in the browser, vitest in node) supplies Pyodide + the
// artifact bytes — this module never reaches the network/disk itself, so it's identical in both environments.

export interface NativeManifest {
  pyodide: string;
  loadPackage: string[]; // ABI-matched binary wheels from Pyodide's own bundle (never micropip → no abort)
  required: string[]; // pure-Python deps via micropip
  osSurface: string[];
}

export interface PyodideLike {
  loadPackage(names: string[]): Promise<unknown>;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  unpackArchive(buffer: ArrayBuffer | Uint8Array, format: string, options?: { extractDir?: string }): void;
  globals: { set(name: string, value: unknown): void };
  FS: { mkdirTree(path: string): void };
}

/** A native-WS lifecycle event the in-process ASGI driver pushes to the worker (which maps it onto the
 *  holo-protocol wsopened/wsmsg/wsclosed/wserr frames). `kind`: accept | message | close | error. */
export type SocketEvent = { sid: number; kind: "accept" | "message" | "close" | "error"; data: string; code: number };

/** The holospace OS surface (process/fs/net) the agent's shell tools route to — optional; null for the
 *  dashboard path (no subprocess). Wired at G5. */
export interface NativeHost {
  exec?: unknown;
}

export interface NativeResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export interface NativeBackend {
  /** Drive a real request through the in-Pyodide ASGI app (the path the dashboard's __HOLO_FETCH__ takes). */
  request(method: string, path: string, headers?: Record<string, string>, body?: Uint8Array | null): Promise<NativeResponse>;
  /** The frozen in-app session token (for the dashboard's authenticated calls). */
  token: string;
  /** Open a real WebSocket against the in-process ASGI app (the path the dashboard's chat __HOLO_WS__ takes).
   *  Returns the native sid; lifecycle events arrive via {@link onSocketEvent}. */
  openSocket(path: string): number;
  /** Deliver a client text frame into the ASGI app's receive channel for this socket. */
  sendSocket(sid: number, text: string): void;
  /** Close the client side of this socket (ASGI websocket.disconnect). */
  closeSocket(sid: number): void;
  /** Register the single sink the ASGI WS driver pushes accept/message/close/error events to. */
  onSocketEvent(cb: (e: SocketEvent) => void): void;
}

export async function bootNativeBackend(
  py: PyodideLike,
  opts: { manifest: NativeManifest; sourceTar: Uint8Array; osSurfacePy: string; host?: NativeHost | null; log?: (m: string) => void },
): Promise<NativeBackend> {
  const log = opts.log ?? (() => {});

  // 1. Binary wheels Pyodide ships ABI-matched (pydantic/pyyaml/micropip) — from its own bundle.
  await py.loadPackage(opts.manifest.loadPackage);

  // 2. Pure-Python deps via micropip, ROBUSTLY and PER-DEP: keep_going resolves the whole graph then fails
  //    atomically (so one binary-pinned wheel absent from Pyodide would take the dashboard deps down with it).
  //    Installing each independently lets every resolvable dep install while a provider-only/binary dep (jiter,
  //    pillow, ruamel-clib …) degrades just that provider. DRY — one loop, no per-dep special-casing.
  const degraded = (await py.runPythonAsync(
    `import micropip, json\n_degraded=[]\n` +
      `for _r in json.loads(${q(JSON.stringify(opts.manifest.required))}):\n` +
      `  try:\n    await micropip.install(_r)\n` +
      `  except Exception:\n    _degraded.append(_r.split('==')[0].split('>')[0].split('<')[0].split('[')[0].strip())\n` +
      `",".join(_degraded)`,
  )) as string;
  log(degraded ? `deps installed (degraded providers: ${degraded})` : "deps installed");

  // 3. Unpack the REAL Hermes Python onto sys.path; give it a writable HOME for config/state.
  py.FS.mkdirTree("/hermes");
  // Normalize to a plain Uint8Array — a node Buffer (vitest) carries a typed-array tag Pyodide rejects; the
  // browser's fetch→Uint8Array path is already plain, so this copy is a no-op there in effect.
  const tar = new Uint8Array(opts.sourceTar.buffer ?? opts.sourceTar, opts.sourceTar.byteOffset ?? 0, opts.sourceTar.byteLength);
  py.unpackArchive(tar.slice(), "tar", { extractDir: "/hermes" });
  py.runPython(`import sys, os, tempfile\nsys.path.insert(0, "/hermes")\nos.environ.setdefault("HOME", tempfile.mkdtemp())`);

  // 4. The ONE OS-surface adapter — installed BEFORE the app imports (TTY/process modules are probed at import).
  py.runPython(
    `import os\nos.makedirs("/native", exist_ok=True)\nopen("/native/os_surface.py","w").write(${q(opts.osSurfacePy)})\n` +
      `import sys; sys.path.insert(0, "/native")\nimport os_surface; os_surface.install(host=None)`,
  );
  log("os-surface installed");

  // 5. Import the real app + build the in-process ASGI request fn (httpx ASGITransport — same path proven at 15 ms).
  await py.runPythonAsync(`
import hermes_cli.web_server as _ws
import httpx
_transport = httpx.ASGITransport(app=_ws.app)
async def _native_request(method, path, headers, body):
    content = bytes(body) if body is not None else None  # JS Uint8Array → memoryview → bytes for httpx
    async with httpx.AsyncClient(transport=_transport, base_url="http://app") as c:
        r = await c.request(method, path, headers=dict(headers or []), content=content)
        return [r.status_code, [list(h) for h in r.headers.items()], r.content]
`);
  log("app imported");

  // 6. In-process ASGI WebSocket driver — the WS analogue of the httpx ASGITransport above (httpx does NOT
  //    speak WebSocket). It drives the app's `websocket` scope directly: a per-socket asyncio receive queue +
  //    a send callback that pushes accept/send/close back out through ONE JS sink. This serves the REAL
  //    /api/ws gateway (tui_gateway.handle_ws) in-process — no PTY, no subprocess. The synthetic scope sets a
  //    loopback client + Host so the dashboard's WS Host/Origin + peer guards accept it (native leaves
  //    app.state unset → loopback/`?token=` auth, which the client already appends).
  py.runPython(`
import asyncio as _aio
from urllib.parse import urlsplit as _urlsplit

_native_ws = {}
_native_ws_seq = [0]

def _native_ws_emit(sid, kind, text="", code=0):
    cb = globals().get("_native_ws_sink")
    if cb is not None:
        cb(sid, kind, text, code)

class _NativeWS:
    def __init__(self, sid, path):
        self._sid = sid
        self._q = _aio.Queue()
        self._done = False
        u = _urlsplit(path)
        self._scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": u.path,
            "raw_path": u.path.encode("utf-8"),
            "query_string": u.query.encode("utf-8"),
            "root_path": "",
            "headers": [(b"host", b"app")],
            "client": ("127.0.0.1", 0),
            "server": ("app", 80),
            "subprotocols": [],
            "state": {},
        }
        self._q.put_nowait({"type": "websocket.connect"})
        self._task = _aio.ensure_future(self._run())

    async def _receive(self):
        return await self._q.get()

    async def _send(self, event):
        t = event.get("type")
        if t == "websocket.accept":
            _native_ws_emit(self._sid, "accept")
        elif t == "websocket.send":
            txt = event.get("text")
            if txt is None and event.get("bytes") is not None:
                txt = bytes(event["bytes"]).decode("utf-8", "replace")
            if txt is not None:
                _native_ws_emit(self._sid, "message", txt)
        elif t == "websocket.close":
            self._finish(int(event.get("code", 1000)), str(event.get("reason") or ""))

    def _finish(self, code, reason):
        if self._done:
            return
        self._done = True
        _native_ws_emit(self._sid, "close", reason, code)

    async def _run(self):
        try:
            await _ws.app(self._scope, self._receive, self._send)
        except Exception as exc:
            if not self._done:
                self._done = True
                import traceback as _tb
                _native_ws_emit(self._sid, "error", f"{exc!r}\\n{_tb.format_exc()}")
        else:
            self._finish(1000, "")

    def client_send(self, text):
        if not self._done:
            self._q.put_nowait({"type": "websocket.receive", "text": text})

    def client_close(self):
        if not self._done:
            self._q.put_nowait({"type": "websocket.disconnect", "code": 1000})

def _native_ws_open(path):
    _native_ws_seq[0] += 1
    sid = _native_ws_seq[0]
    _native_ws[sid] = _NativeWS(sid, path)
    return sid

def _native_ws_send(sid, text):
    s = _native_ws.get(sid)
    if s is not None:
        s.client_send(text)

def _native_ws_close(sid):
    s = _native_ws.pop(sid, None)
    if s is not None:
        s.client_close()
`);
  log("ws driver installed");

  const token = py.runPython(`_ws._SESSION_TOKEN`) as string;
  const requestFn = py.runPython(`_native_request`) as (
    m: string, p: string, h: [string, string][], b: Uint8Array | null,
  ) => Promise<{ toJs(): [number, [string, string][], Uint8Array]; destroy(): void }>;
  const wsOpenFn = py.runPython(`_native_ws_open`) as (path: string) => number;
  const wsSendFn = py.runPython(`_native_ws_send`) as (sid: number, text: string) => void;
  const wsCloseFn = py.runPython(`_native_ws_close`) as (sid: number) => void;

  // ONE long-lived sink the Python WS driver pushes events to (kept alive via globals.set, never destroyed —
  // backend lifetime = page lifetime). The worker registers its dispatcher through onSocketEvent.
  let socketSink: ((e: SocketEvent) => void) | null = null;
  py.globals.set("_native_ws_sink", (sid: number, kind: SocketEvent["kind"], data: string, code: number) => {
    socketSink?.({ sid, kind, data: data ?? "", code: code ?? 0 });
  });

  return {
    token,
    async request(method, path, headers = {}, body = null) {
      // Pyodide maps JS `null` to a JsNull sentinel (not Python None); `undefined` maps to None — pass that for
      // a bodyless request so the Python side sees a real None.
      const proxy = await requestFn(method, path, Object.entries(headers), body ?? undefined);
      const [status, hdrs, b] = proxy.toJs({ create_proxies: false });
      proxy.destroy?.();
      return { status, headers: hdrs, body: b instanceof Uint8Array ? b : new Uint8Array(b) };
    },
    openSocket(path) { return wsOpenFn(path); },
    sendSocket(sid, text) { wsSendFn(sid, text); },
    closeSocket(sid) { wsCloseFn(sid); },
    onSocketEvent(cb) { socketSink = cb; },
  };
}

// JSON-encode a string for safe embedding in a Python string literal (the runtime ships small code snippets).
function q(s: string): string {
  return JSON.stringify(s);
}
