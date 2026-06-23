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
  FS: { mkdirTree(path: string): void };
}

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

  const token = py.runPython(`_ws._SESSION_TOKEN`) as string;
  const requestFn = py.runPython(`_native_request`) as (
    m: string, p: string, h: [string, string][], b: Uint8Array | null,
  ) => Promise<{ toJs(): [number, [string, string][], Uint8Array]; destroy(): void }>;

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
  };
}

// JSON-encode a string for safe embedding in a Python string literal (the runtime ships small code snippets).
function q(s: string): string {
  return JSON.stringify(s);
}
