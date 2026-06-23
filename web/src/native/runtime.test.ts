import { describe, it, expect, beforeAll } from "vitest";
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bootNativeBackend, type NativeBackend, type NativeManifest } from "./runtime";

// G1/G2 gate for the native-exec Hermes backend: the REAL runtime boots the REAL Hermes Python under Pyodide
// and serves real /api reads + writes native-fast (the emulated interpreter wall took >360 s). DRY — this tests
// the production runtime.ts + the build artifacts, not a bespoke harness.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NATIVE = path.join(REPO, "web/public/native");
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("native-exec Hermes backend", () => {
  let backend: NativeBackend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let py: any;

  beforeAll(async () => {
    // Build the artifacts from the REAL source (the same step the dashboard build runs).
    execFileSync("node", ["web/scripts/bundle-hermes-native.mjs"], { cwd: REPO });
    const manifest = JSON.parse(readFileSync(path.join(NATIVE, "deps.json"), "utf8")) as NativeManifest;
    const sourceTar = readFileSync(path.join(NATIVE, "hermes-src.tar"));
    const osSurfacePy = readFileSync(path.join(REPO, "web/src/native/os_surface.py"), "utf8");
    py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
    backend = await bootNativeBackend(py as never, { manifest, sourceTar, osSurfacePy });
  }, 180_000);

  it("G1: the full unmodified Hermes app boots native and yields a session token", () => {
    expect(backend.token).toBeTruthy();
    expect(backend.token.length).toBeGreaterThan(8);
  });

  it("G2: a real GET /api/config returns 200 native-fast (was >360 s emulated)", async () => {
    const auth = { authorization: `Bearer ${backend.token}` };
    await backend.request("GET", "/api/config", auth); // warm
    const t0 = performance.now();
    const r = await backend.request("GET", "/api/config", auth);
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(2000);
  });

  it("G2: a real local MUTATION round-trips native (create cron job → list → delete)", async () => {
    const auth = { authorization: `Bearer ${backend.token}`, "content-type": "application/json" };
    const made = await backend.request("POST", "/api/cron/jobs?profile=default", auth,
      enc(JSON.stringify({ name: "native_probe_job", prompt: "x", schedule: "0 9 * * 1" })));
    expect(made.status, dec(made.body)).toBeLessThan(300);
    const id = JSON.parse(dec(made.body)).id as string;
    const list = await backend.request("GET", "/api/cron/jobs?profile=default", { authorization: `Bearer ${backend.token}` });
    expect(list.status).toBe(200);
    expect(dec(list.body)).toContain("native_probe_job"); // the write persisted + is read back, all native
    await backend.request("DELETE", `/api/cron/jobs/${id}?profile=default`, auth);
  });

  // G5a: the chat transport, NATIVE. /api/ws is the real tui_gateway WebSocket — and the gateway is threaded
  // (it spawns a daemon reaper at import, offloads dispatch via asyncio.to_thread, etc.). The cooperative thread
  // surface (os_surface) backs those OS threads on the single-threaded event loop, so the REAL gateway imports
  // and serves NATIVELY — no emulator, no >360 s establishment. The driver must accept the upgrade and emit the
  // gateway.ready handshake. This is the hologram/holospaces bottleneck elimination: the agent transport runs
  // native, not behind the interpreter wall.
  it("G5a: real /api/ws imports + serves gateway.ready NATIVE (cooperative thread surface, no emulator)", async () => {
    const events: { kind: string; data: string }[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no gateway.ready in 20s; events=${JSON.stringify(events)}`)), 20_000);
      backend.onSocketEvent((e) => {
        events.push({ kind: e.kind, data: e.data });
        if (e.kind === "error") { clearTimeout(timer); reject(new Error(`ws error: ${e.data}`)); }
        if (e.kind === "message" && e.data.includes("gateway.ready")) { clearTimeout(timer); resolve(); }
      });
    });
    const sid = backend.openSocket(`/api/ws?token=${backend.token}`);
    await ready;
    expect(events.some((e) => e.kind === "accept"), "upgrade accepted natively").toBe(true);
    const msg = events.find((e) => e.kind === "message")!;
    expect(JSON.parse(msg.data).params.type, "first frame is gateway.ready, served native").toBe("gateway.ready");
    backend.closeSocket(sid);
  });

  // G5b: a real JSON-RPC dispatch round-trips NATIVE — beyond the handshake into server.dispatch, which the
  // gateway runs via asyncio.to_thread and which itself synchronizes on threading.Event/Lock. A well-formed
  // response (result or error) with the matching id proves the cooperative thread surface carries the gateway's
  // dispatch path on the single thread, native — the deep proof the threaded agent can run without the emulator.
  it("G5b: a real JSON-RPC dispatch round-trips NATIVE over /api/ws (session.list)", async () => {
    let sid = 0;
    const got = new Promise<{ id?: number; result?: unknown; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no JSON-RPC response in 25s")), 25_000);
      backend.onSocketEvent((e) => {
        if (e.kind === "error") { clearTimeout(timer); reject(new Error(`ws error: ${e.data}`)); return; }
        if (e.kind !== "message") return;
        const m = JSON.parse(e.data);
        if (m.params?.type === "gateway.ready") {
          backend.sendSocket(sid, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }));
        } else if (m.id === 1) { clearTimeout(timer); resolve(m); }
      });
    });
    sid = backend.openSocket(`/api/ws?token=${backend.token}`);
    const resp = await got;
    expect(resp.id, "the dispatch reply carries our request id").toBe(1);
    expect(resp.result !== undefined || resp.error !== undefined, "a well-formed JSON-RPC reply (dispatch ran)").toBe(true);
    backend.closeSocket(sid);
  });

  // G6-codec: the native network surface speaks the EXACT established CC-16 egress wire format the router
  // extension (background.js) and the guest's wsnet.rs already use — so the agent's outbound sockets reuse the
  // one egress channel, DRY. A byte-level mismatch would silently break every outbound call, so pin it here.
  it("G6: os_net encodes/decodes the established CC-16 egress frames byte-for-byte", () => {
    const osNetPy = readFileSync(path.join(REPO, "web/src/native/os_net.py"), "utf8");
    const out = py.runPython(`
import sys, types
_m = types.ModuleType("os_net"); exec(${JSON.stringify(osNetPy)}, _m.__dict__)
# OPEN id=1 → 1.2.3.4:443  == 0x01, id(4 BE), ip(4), port(2 BE)
_open = _m.encode_open(1, (1, 2, 3, 4), 443)
# DATA id=1 body=b"hi"
_data = _m.encode_data(1, b"hi")
# parse an ext→tab RDATA id=7 body=b"ok"  (0x12, 00000007, 'ok')
_op, _cid, _body = _m.parse_frame(bytes([0x12, 0, 0, 0, 7]) + b"ok")
import json
json.dumps({
  "open": list(_open),
  "data": list(_data),
  "rdata": [_op, _cid, _body.decode()],
  "ipv4_name": _m.ipv4_of("api.anthropic.com"),   # a name → None (needs DNS)
  "ipv4_dotted": _m.ipv4_of("127.0.0.1"),
})
`) as string;
    const r = JSON.parse(out);
    // OPEN 1.2.3.4:443 — op, id big-endian, ip octets, port big-endian (443 = 0x01BB).
    expect(r.open).toEqual([0x01, 0, 0, 0, 1, 1, 2, 3, 4, 0x01, 0xbb]);
    expect(r.data).toEqual([0x02, 0, 0, 0, 1, 0x68, 0x69]); // "hi"
    expect(r.rdata).toEqual([0x12, 7, "ok"]);
    expect(r.ipv4_name).toBeNull(); // a hostname needs DNS (resolved separately), not a dotted-quad
    expect(r.ipv4_dotted).toEqual([127, 0, 0, 1]);
  });

  // G6-socket: the egress-backed socket state machine — connect→OPEN(+wait OPENED), send→DATA, recv←RDATA,
  // peer CLOSED→EOF — over the CC-16 frames. The in-browser blocking pump is run_sync (JSPI); here a
  // queue-driven pump delivers the inbound frames synchronously so the connection logic is gated node-side.
  it("G6: EgressSocket drives a CC-16 connection (connect → send → recv → close)", () => {
    const out = py.runPython(`
import types, json
_m = types.ModuleType("os_net"); exec(${JSON.stringify(readFileSync(path.join(REPO, "web/src/native/os_net.py"), "utf8"))}, _m.__dict__)

def mk(cid):
    sent = []; inbox = []
    s = _m.EgressSocket(cid, lambda f: sent.append(list(f)))
    s._block = lambda: s.feed(bytes(inbox.pop(0)))  # run_sync's role in the browser: deliver the next frame
    return s, sent, inbox

# A — happy path: connect→OPEN(+OPENED), send→DATA, recv←RDATA, then WE close→CLOSE.
a, a_sent, a_inbox = mk(1)
a_inbox.append(list(bytes([0x11, 0,0,0,1])))                    # OPENED id=1
a.connect("93.184.216.34", 443)                                # dotted-quad (DNS resolved upstream)
assert a.state == "open", a.state
a.send(b"GET / HTTP/1.0\\r\\n\\r\\n")                            # → DATA
a_inbox.append(list(bytes([0x12, 0,0,0,1]) + b"HTTP/1.0 200 OK"))  # RDATA id=1
got = a.recv(65536)
a.close()                                                       # still open → emits CLOSE

# B — peer closes: CLOSED → recv EOF, and our close() then does NOT re-emit.
b, b_sent, b_inbox = mk(2)
b_inbox.append(list(bytes([0x11, 0,0,0,2]))); b.connect("1.1.1.1", 443)
b_inbox.append(list(bytes([0x13, 0,0,0,2])))                    # CLOSED id=2
eof = b.recv(65536)
b.close()

json.dumps({
  "open_frame": a_sent[0], "data_op": a_sent[1][0], "recv": got.decode(),
  "a_frames": a_sent, "a_state": a.state,
  "eof": eof.decode(), "b_frames": b_sent, "b_state": b.state,
})
`) as string;
    const r = JSON.parse(out);
    expect(r.open_frame).toEqual([0x01, 0, 0, 0, 1, 93, 184, 216, 34, 0x01, 0xbb]); // OPEN 93.184.216.34:443
    expect(r.data_op).toBe(0x02); // DATA
    expect(r.recv).toBe("HTTP/1.0 200 OK"); // RDATA delivered as recv bytes
    expect(r.a_frames).toEqual([[0x01,0,0,0,1,93,184,216,34,0x01,0xbb], [0x02,0,0,0,1,71,69,84,32,47,32,72,84,84,80,47,49,46,48,13,10,13,10], [0x03,0,0,0,1]]); // OPEN, DATA, CLOSE
    expect(r.a_state).toBe("closed");
    expect(r.eof).toBe(""); // peer CLOSED → EOF
    expect(r.b_frames).toEqual([[0x01,0,0,0,2,1,1,1,1,0x01,0xbb]]); // only OPEN — peer closed, so no redundant CLOSE
    expect(r.b_state).toBe("closed");
  });
});
