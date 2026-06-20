// holo-transport.ts — the `hologram` transport: route the dashboard's REST + WebSocket calls to
// `web_server.py` running INSIDE the in-browser RISC-V guest, over the emulator's in-process loopback
// ingress bridge (holospaces-web `Workspace.dial_guest`/`guest_send`/`guest_recv`/`guest_close`/
// `guest_is_open`, witnessed by `CC-33`). The wire format (HTTP/1.1 + RFC-6455) is the pure, unit-
// tested codec in `./holo-wire.mjs`; this file is the browser glue that layers `fetch`/`WebSocket`
// semantics on top and installs them via the `api.ts` transport seam (`setFetchImpl` +
// `setSocketFactory`).
//
// Status: the codec is proven (BDD). End-to-end against a real guest is Stage C/D — it needs the
// booted guest (Stage B) and the one holospaces-web boot shim that enables loopback ingress on the
// RISC-V target (modeled on the AArch64 `boot_devcontainer_opfs_full`). Until then this transport is
// driven against a mock `GuestBridge` in tests.

import {
  encodeHttpRequest,
  parseHttpResponse,
  wsHandshakeRequest,
  readWsHandshakeResponse,
  encodeWsFrame,
  decodeWsFrames,
  base64,
  maskKey,
  type WsFrame,
} from "./holo-wire.mjs";
import { setFetchImpl, setSocketFactory, resetTransport } from "./api";

/** The host→guest loopback ingress surface. Mirrors holospaces-web `Workspace` (snake_case in the
 * wasm-bindgen export); `fromWorkspace` adapts it. A connection id is returned by `dialGuest`; the
 * host pumps the machine with `run` and exchanges bytes with `guestSend`/`guestRecv`. */
export interface GuestBridge {
  dialGuest(port: number): number;
  guestSend(id: number, data: Uint8Array): void;
  guestRecv(id: number): Uint8Array;
  guestClose(id: number): void;
  guestIsOpen(id: number): boolean;
  /** Advance the emulator by `budget` instructions so queued bytes flow. */
  run(budget: number): void;
}

/** Adapt a holospaces-web `Workspace` (snake_case wasm-bindgen methods) to `GuestBridge`. */
export function fromWorkspace(ws: {
  dial_guest(p: number): number | undefined;
  guest_send(id: number, d: Uint8Array): void;
  guest_recv(id: number): Uint8Array;
  guest_close(id: number): void;
  guest_is_open(id: number): boolean;
  run(budget: number): boolean;
}): GuestBridge {
  return {
    dialGuest: (p) => {
      const id = ws.dial_guest(p);
      if (id == null) throw new Error("loopback ingress not enabled on this guest (needs the RISC-V routed_opfs+enable_loopback boot fn)");
      return id;
    },
    guestSend: (id, d) => ws.guest_send(id, d),
    guestRecv: (id) => ws.guest_recv(id),
    guestClose: (id) => ws.guest_close(id),
    guestIsOpen: (id) => ws.guest_is_open(id),
    run: (b) => { ws.run(b); },
  };
}

const PUMP_BUDGET = 2_000_000; // instructions per tick (matches the CC-33 witness cadence)
const MAX_TICKS = 4000;

/** Extract the dashboard-relative path (+query) from a `${BASE}${path}` or absolute URL. */
function pathOf(input: string): string {
  if (/^[a-z]+:\/\//i.test(input)) { const u = new URL(input); return u.pathname + u.search; }
  if (/^wss?:\/\//i.test(input)) { const u = new URL(input); return u.pathname + u.search; }
  return input.startsWith("/") ? input : "/" + input;
}

/** A `fetch`-like over the bridge: one dial per request (Connection: close), pump until the response
 * is fully framed (Content-Length / chunked / connection close). */
export function holoFetch(bridge: GuestBridge, port: number) {
  return async function hologramFetch(input: string, init?: RequestInit): Promise<Response> {
    const path = pathOf(input);
    const method = (init?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === "string" ? init.body
      : init?.body instanceof Uint8Array ? init.body
      : init?.body == null ? undefined
      : String(init.body);

    const id = bridge.dialGuest(port);
    bridge.guestSend(id, encodeHttpRequest({ method, path, headers, body }));

    let buf = new Uint8Array(0);
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      bridge.run(PUMP_BUDGET);
      const chunk = bridge.guestRecv(id);
      if (chunk.length) { const m = new Uint8Array(buf.length + chunk.length); m.set(buf); m.set(chunk, buf.length); buf = m; }
      const closed = !bridge.guestIsOpen(id);
      const parsed = parseHttpResponse(buf, { closed });
      if (parsed.complete) {
        bridge.guestClose(id);
        const h = new Headers(parsed.headers as Record<string, string>);
        return new Response(parsed.body && parsed.body.length ? parsed.body : null, {
          status: parsed.status, statusText: parsed.statusText, headers: h,
        });
      }
      if (closed) break;
      await new Promise((r) => setTimeout(r, 0)); // yield so the worker/event loop breathes
    }
    bridge.guestClose(id);
    throw new Error(`hologram fetch ${method} ${path}: no complete response after ${MAX_TICKS} ticks`);
  };
}

type Listener = (ev: { type: string; data?: unknown; code?: number; reason?: string }) => void;

/** A `WebSocket`-like over the bridge: handshake then RFC-6455 frames. Implements the subset the
 * dashboard uses (binaryType, readyState, send, close, addEventListener, on*). Cast to `WebSocket`
 * at the factory boundary. */
export class HoloSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;

  private listeners: Record<string, Set<Listener>> = {};
  private id: number;
  private key: string;
  private upgraded = false;
  private buf = new Uint8Array(0);

  constructor(private bridge: GuestBridge, port: number, url: string, private schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 0)) {
    const path = pathOf(url);
    const rnd = maskKey(); const k2 = maskKey(); const k3 = maskKey(); const k4 = maskKey();
    this.key = base64(new Uint8Array([...rnd, ...k2, ...k3, ...k4]));
    this.id = bridge.dialGuest(port);
    bridge.guestSend(this.id, wsHandshakeRequest(path, this.key));
    this.schedule(() => this.pump());
  }

  private emit(type: string, ev: { type: string; data?: unknown; code?: number; reason?: string }) {
    const own = (this as unknown as Record<string, Listener | null>)["on" + type];
    if (typeof own === "function") own(ev);
    for (const l of this.listeners[type] || []) l(ev);
  }

  private append(chunk: Uint8Array) {
    if (!chunk.length) return;
    const m = new Uint8Array(this.buf.length + chunk.length); m.set(this.buf); m.set(chunk, this.buf.length); this.buf = m;
  }

  /** One pump step — exposed so tests can drive it deterministically without timers. */
  pump(): void {
    if (this.readyState === HoloSocket.CLOSED) return;
    this.bridge.run(PUMP_BUDGET);
    this.append(this.bridge.guestRecv(this.id));
    if (!this.upgraded) {
      const hs = readWsHandshakeResponse(this.buf, this.key);
      if (hs.pending) { this.reschedule(); return; }
      if (!hs.ok) { this.fail("websocket handshake rejected"); return; }
      this.upgraded = true;
      this.buf = hs.rest || new Uint8Array(0);
      this.readyState = HoloSocket.OPEN;
      this.emit("open", { type: "open" });
    }
    const { frames, rest } = decodeWsFrames(this.buf);
    this.buf = rest;
    for (const f of frames) this.handleFrame(f);
    if (!this.bridge.guestIsOpen(this.id) && this.readyState !== HoloSocket.CLOSED) {
      this.readyState = HoloSocket.CLOSED;
      this.emit("close", { type: "close", code: 1006, reason: "guest connection closed" });
      return;
    }
    if (this.readyState !== HoloSocket.CLOSED) this.reschedule();
  }

  private reschedule() { this.schedule(() => this.pump()); }

  private handleFrame(f: WsFrame) {
    if (f.opcode === 0x8) { // close
      this.readyState = HoloSocket.CLOSED;
      this.emit("close", { type: "close", code: 1000, reason: "" });
      this.bridge.guestClose(this.id);
      return;
    }
    if (f.opcode === 0x9) { this.bridge.guestSend(this.id, encodeWsFrame(0xA, f.payload)); return; } // ping→pong
    if (f.opcode === 0x1) this.emit("message", { type: "message", data: new TextDecoder().decode(f.payload) });
    else if (f.opcode === 0x2) {
      const data = this.binaryType === "arraybuffer" ? f.payload.buffer.slice(f.payload.byteOffset, f.payload.byteOffset + f.payload.byteLength) : f.payload;
      this.emit("message", { type: "message", data });
    }
  }

  private fail(msg: string) {
    this.readyState = HoloSocket.CLOSED;
    this.emit("error", { type: "error", data: msg });
    this.emit("close", { type: "close", code: 1006, reason: msg });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== HoloSocket.OPEN) throw new Error("HoloSocket not open");
    if (typeof data === "string") this.bridge.guestSend(this.id, encodeWsFrame(0x1, data));
    else {
      const u = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
      this.bridge.guestSend(this.id, encodeWsFrame(0x2, u));
    }
  }

  close(): void {
    if (this.readyState === HoloSocket.CLOSED) return;
    this.readyState = HoloSocket.CLOSING;
    try { this.bridge.guestSend(this.id, encodeWsFrame(0x8, new Uint8Array(0))); } catch { /* already gone */ }
    this.bridge.guestClose(this.id);
    this.readyState = HoloSocket.CLOSED;
  }

  addEventListener(type: string, listener: Listener): void { (this.listeners[type] ??= new Set()).add(listener); }
  removeEventListener(type: string, listener: Listener): void { this.listeners[type]?.delete(listener); }
}

/** Install the hologram transport: subsequent `fetchJSON`/`authedFetch` and `openSocket*` calls route
 * to the in-guest `web_server.py` over the bridge. Returns an uninstall fn restoring the defaults. */
export function installHologramTransport(bridge: GuestBridge, opts: { port?: number } = {}): () => void {
  const port = opts.port ?? 9119;
  setFetchImpl(holoFetch(bridge, port) as unknown as (url: string, init?: RequestInit) => Promise<Response>);
  setSocketFactory((url: string) => new HoloSocket(bridge, port, url) as unknown as WebSocket);
  return resetTransport; // restore origin-server defaults (socket + fetch construction lives only in api.ts)
}
