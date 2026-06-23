import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectEgress } from "./holo-egress";

// Egress carrier V&V — the existing "native install" pattern (extension/egress-test.mjs) brought into the
// hermes-web suite so the agent's window to the internet is tested, not skipped. The dashboard's network
// features (Models / MCP / Channels / the agent Chat) all ride this carrier: the guest's outbound traffic
// leaves as opaque OPEN/DATA/CLOSE frames → the page connector (holo-egress.connectEgress) → the SHIPPED
// router extension service worker (public/holo/extension/background.js) → Direct Sockets. Direct Sockets
// needs a gated Chrome to run for real, but its CONTRACT is faithfully polyfilled with node:net (same
// `new TCPSocket(host,port)`, `await .opened → {readable,writable}`, `.close()`), so we drive the REAL
// connector + the REAL extension against a REAL socket and prove the frames round-trip end to end.

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const EXT_BACKGROUND = path.resolve(__dirname_, "../../public/holo/extension/background.js");

const OP_OPEN = 0x01, OP_DATA = 0x02, OP_CLOSE = 0x03;
const OP_OPENED = 0x11, OP_RDATA = 0x12, OP_FAILED = 0x14;
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const openFrame = (id: number, ip: number[], p: number) =>
  Uint8Array.from([OP_OPEN, ...u32(id), ...ip, (p >> 8) & 255, p & 255]);
const dataFrame = (id: number, b: Uint8Array) => {
  const f = new Uint8Array(5 + b.length);
  f.set([OP_DATA, ...u32(id)]);
  f.set(b, 5);
  return f;
};

interface FakePort {
  name: string;
  postMessage(m: unknown): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

/** Install the SHIPPED extension service worker into this process with Direct Sockets backed by node:net,
 *  and a chrome.runtime that links connectEgress's port to the worker's onConnectExternal port. */
function installNativeGateway(): void {
  class TCPSocketPolyfill {
    _sock: net.Socket;
    opened: Promise<{ readable: ReadableStream; writable: WritableStream }>;
    constructor(host: string, port: number) {
      const sock = net.connect(port, host);
      this._sock = sock;
      // The egress protocol surfaces failures explicitly (OP_FAILED / OP_CLOSED); keep a permanent error
      // sink so node never treats a refused/torn socket as an unhandled error during teardown.
      sock.on("error", () => {});
      this.opened = new Promise((resolve, reject) => {
        sock.once("error", reject);
        sock.once("connect", () => {
          // Hand-built web streams (vs Duplex.toWeb) so a torn/destroyed socket CLOSES the readable rather
          // than throwing ERR_STREAM_PREMATURE_CLOSE — the protocol already reports CLOSED, no stray error.
          const readable = new ReadableStream<Uint8Array>({
            start(ctrl) {
              sock.on("data", (d: Buffer) => { try { ctrl.enqueue(new Uint8Array(d)); } catch { /* closed */ } });
              const fin = () => { try { ctrl.close(); } catch { /* already closed */ } };
              sock.on("end", fin); sock.on("close", fin); sock.on("error", fin);
            },
            cancel() { try { sock.destroy(); } catch { /* gone */ } },
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) { return new Promise<void>((res) => sock.write(chunk, () => res())); },
            close() { try { sock.end(); } catch { /* gone */ } },
            abort() { try { sock.destroy(); } catch { /* gone */ } },
          });
          resolve({ readable, writable });
        });
      });
    }
    close() {
      try { this._sock.destroy(); } catch { /* already gone */ }
    }
  }
  (globalThis as Record<string, unknown>).TCPSocket = TCPSocketPolyfill;

  const connectHandlers: ((port: FakePort) => void)[] = [];
  function pair(): [FakePort, FakePort] {
    const aL: ((m: unknown) => void)[] = [], bL: ((m: unknown) => void)[] = [];
    const aD: (() => void)[] = [], bD: (() => void)[] = [];
    const a: FakePort = {
      name: "egress", postMessage: (m) => bL.forEach((l) => l(m)),
      onMessage: { addListener: (cb) => aL.push(cb) }, onDisconnect: { addListener: (cb) => aD.push(cb) },
      disconnect: () => bD.forEach((cb) => cb()),
    };
    const b: FakePort = {
      name: "egress", postMessage: (m) => aL.forEach((l) => l(m)),
      onMessage: { addListener: (cb) => bL.push(cb) }, onDisconnect: { addListener: (cb) => bD.push(cb) },
      disconnect: () => aD.forEach((cb) => cb()),
    };
    return [a, b];
  }
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onConnectExternal: { addListener: (h: (p: FakePort) => void) => connectHandlers.push(h) },
      onMessageExternal: { addListener: () => {} },
      // connectEgress (the page) opens a port; hand the extension its linked end.
      connect: () => {
        const [tab, ext] = pair();
        connectHandlers[0](ext);
        return tab;
      },
    },
    permissions: { request: async () => true },
  };

  // Load the SHIPPED service worker; it registers onConnectExternal against the chrome mock above.
  (0, eval)(readFileSync(EXT_BACKGROUND, "utf8"));
}

describe("egress carrier (shipped connector + shipped extension + real sockets)", () => {
  let echo: net.Server;
  let echoPort = 0;

  beforeAll(() => new Promise<void>((resolve) => {
    echo = net.createServer((s) => s.pipe(s)); // a real "host on the internet" that echoes
    echo.listen(0, "127.0.0.1", () => { echoPort = (echo.address() as net.AddressInfo).port; resolve(); });
  }));
  afterAll(() => new Promise<void>((resolve) => echo.close(() => resolve())));

  it("round-trips OPEN→OPENED and DATA→RDATA through the real carrier", async () => {
    installNativeGateway();
    const chan = connectEgress("test-ext");
    expect(chan, "connectEgress opened a channel to the (mock-runtime) extension").not.toBeNull();

    const frames: Uint8Array[] = [];
    chan!.onFrame((f) => frames.push(f));
    const waitFor = async (pred: (f: Uint8Array) => boolean, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = frames.find(pred);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    };

    // OPEN: the shipped extension opens a real socket to the echo server and reports OPENED.
    chan!.send(openFrame(7, [127, 0, 0, 1], echoPort));
    expect(await waitFor((f) => f[0] === OP_OPENED && f[4] === 7), "OPEN → real socket → OPENED").toBeTruthy();

    // DATA: forwarded to the host; the echo returns framed as RDATA.
    const payload = new TextEncoder().encode("hello, internet, via the shipped egress carrier");
    chan!.send(dataFrame(7, payload));
    let got: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && got.length < payload.length) {
      for (const f of frames) {
        if (f[0] === OP_RDATA && f[4] === 7) {
          got = got.concat([...f.subarray(5)]);
          frames[frames.indexOf(f)] = new Uint8Array(0); // consume
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(new TextDecoder().decode(Uint8Array.from(got)), "DATA echoed back as RDATA").toBe(
      new TextDecoder().decode(payload),
    );

    // CLOSE: tearing the connection down emits CLOSED (and frees the socket).
    chan!.send(Uint8Array.from([OP_CLOSE, ...u32(7)]));
    chan!.close();
  });

  it("reports OP_FAILED for an unreachable host (errors are surfaced, not dropped)", async () => {
    installNativeGateway();
    const chan = connectEgress("test-ext")!;
    const frames: Uint8Array[] = [];
    chan.onFrame((f) => frames.push(f));
    chan.send(openFrame(9, [127, 0, 0, 1], 1)); // port 1 → connection refused
    const t0 = Date.now();
    let failed = false;
    while (Date.now() - t0 < 4000 && !failed) {
      failed = frames.some((f) => f[0] === OP_FAILED && f[4] === 9);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(failed, "unreachable host → OP_FAILED").toBe(true);
    chan.close();
  });
});
