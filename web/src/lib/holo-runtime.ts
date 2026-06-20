// holo-runtime.ts — the continuous bridge runtime: ONE pump that drives the resumed in-browser Hermes
// machine and services everything flowing through it:
//   • loopback INGRESS — the dashboard's /api + WebSocket calls, dialed into the in-guest web_server.py
//     over the in-process loopback bridge (holospaces `dial_guest`/`guest_send`/`guest_recv`).
//   • router EGRESS — the agent's OUTBOUND traffic (model APIs, git, pip/npm) drained from the guest's
//     NAT (`egress_outbound`) and carried to the internet by the router extension, with replies fed
//     back (`egress_inbound`).
//
// Why one continuous loop (vs pumping per request): the agent's outbound connections need the machine
// pumped even when no dashboard request is in flight (a model call streams for seconds). A single
// owner of `ws.run()` advances the machine; fetches/sockets/egress are all serviced each tick. Runs on
// the main thread today; the same class moves into a Web Worker unchanged (it touches no DOM) for the
// production, jank-free build.

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
import { setFetchImpl, setSocketFactory, resetTransport, HERMES_BASE_PATH } from "./api";
import { guestRelativePath } from "./holo-transport";
import type { EgressChannel } from "./holo-egress";

/** The holospaces-web `Workspace` surface the runtime drives (snake_case wasm-bindgen exports). */
export interface HoloWorkspace {
  run(budget: number): boolean;
  dial_guest(port: number): number | undefined;
  guest_send(id: number, data: Uint8Array): void;
  guest_recv(id: number): Uint8Array;
  guest_close(id: number): void;
  guest_is_open(id: number): boolean;
  egress_outbound(): Uint8Array | undefined;
  egress_inbound(frame: Uint8Array): void;
}

const PUMP_BUDGET = 2_000_000; // instructions per tick (matches the CC-33 witness cadence)
const IDLE_MS = 6; // backoff cadence when nothing is moving (keeps egress connections responsive)
const FETCH_TIMEOUT_MS = 120_000;

interface PendingFetch {
  connId: number;
  buf: Uint8Array;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  startedAt: number;
}

type SockListener = (ev: { type: string; data?: unknown; code?: number; reason?: string }) => void;

export class BridgeRuntime {
  private ws: HoloWorkspace;
  private port: number;
  private egress: EgressChannel | null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetches = new Set<PendingFetch>();
  private sockets = new Set<RuntimeSocket>();
  private inbound: Uint8Array[] = []; // egress frames from the extension, applied at the next tick

  constructor(ws: HoloWorkspace, opts: { port?: number; egress?: EgressChannel | null } = {}) {
    this.ws = ws;
    this.port = opts.port ?? 9119;
    this.egress = opts.egress ?? null;
    // Replies from the extension's sockets — queued, applied on-tick (single owner of the machine).
    this.egress?.onFrame((f) => this.inbound.push(f));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Install this runtime as the dashboard's transport (api.ts seam). Returns an uninstall fn. */
  install(): () => void {
    setFetchImpl(this.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>);
    setSocketFactory((url: string) => this.openSocket(url) as unknown as WebSocket);
    return resetTransport;
  }

  // ── the single pump ────────────────────────────────────────────────────────
  private tick = (): void => {
    if (!this.running) return;
    let active = false;

    // 1) egress IN: deliver the extension's replies into the guest NAT before running.
    if (this.inbound.length) {
      for (const f of this.inbound) this.ws.egress_inbound(f);
      this.inbound.length = 0;
      active = true;
    }

    // 2) advance the machine.
    this.ws.run(PUMP_BUDGET);

    // 3) egress OUT: hand the guest's outbound frames to the extension.
    if (this.egress) {
      for (let f = this.ws.egress_outbound(); f != null; f = this.ws.egress_outbound()) {
        this.egress.send(f);
        active = true;
      }
    }

    // 4) service loopback fetches.
    for (const f of this.fetches) if (this.serviceFetch(f)) active = true;

    // 5) service loopback sockets.
    for (const s of this.sockets) if (s.service()) active = true;

    this.timer = setTimeout(this.tick, active ? 0 : IDLE_MS);
  };

  private appended(buf: Uint8Array, chunk: Uint8Array): Uint8Array {
    if (!chunk.length) return buf;
    const m = new Uint8Array(buf.length + chunk.length);
    m.set(buf);
    m.set(chunk, buf.length);
    return m;
  }

  /** Returns true if the fetch made progress this tick. */
  private serviceFetch(f: PendingFetch): boolean {
    const chunk = this.ws.guest_recv(f.connId);
    const closed = !this.ws.guest_is_open(f.connId);
    if (!chunk.length && !closed) {
      if (Date.now() - f.startedAt > FETCH_TIMEOUT_MS) {
        this.ws.guest_close(f.connId);
        this.fetches.delete(f);
        f.reject(new Error("hologram fetch timed out"));
        return true;
      }
      return false;
    }
    f.buf = this.appended(f.buf, chunk);
    const parsed = parseHttpResponse(f.buf, { closed });
    if (parsed.complete) {
      this.ws.guest_close(f.connId);
      this.fetches.delete(f);
      const headers = new Headers(parsed.headers as Record<string, string>);
      f.resolve(
        new Response(parsed.body && parsed.body.length ? (parsed.body as BodyInit) : null, {
          status: parsed.status,
          statusText: parsed.statusText,
          headers,
        }),
      );
      return true;
    }
    if (closed) {
      this.fetches.delete(f);
      f.reject(new Error("hologram fetch: guest closed before a complete response"));
    }
    return true;
  }

  // ── transport surface (installed into api.ts) ────────────────────────────────
  fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const path = guestRelativePath(input, HERMES_BASE_PATH);
    const method = (init?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? init.body
          : init?.body == null
            ? undefined
            : String(init.body);

    const connId = this.ws.dial_guest(this.port);
    if (connId == null) return Promise.reject(new Error("loopback ingress not enabled on this guest"));
    this.ws.guest_send(connId, encodeHttpRequest({ method, path, headers, body }));
    return new Promise<Response>((resolve, reject) => {
      this.fetches.add({ connId, buf: new Uint8Array(0), resolve, reject, startedAt: Date.now() });
    });
  };

  openSocket(url: string): RuntimeSocket {
    const path = guestRelativePath(url, HERMES_BASE_PATH);
    const connId = this.ws.dial_guest(this.port);
    if (connId == null) throw new Error("loopback ingress not enabled on this guest");
    const sock = new RuntimeSocket(this.ws, connId, path);
    sock.onClosed = () => this.sockets.delete(sock);
    this.sockets.add(sock);
    return sock;
  }
}

/** A WebSocket-like over the loopback bridge, serviced by the runtime's pump (it never pumps itself). */
export class RuntimeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: SockListener | null = null;
  onmessage: SockListener | null = null;
  onclose: SockListener | null = null;
  onerror: SockListener | null = null;
  onClosed: (() => void) | null = null;

  private listeners: Record<string, Set<SockListener>> = {};
  private key: string;
  private upgraded = false;
  private buf: Uint8Array = new Uint8Array(0);
  private ws: HoloWorkspace;
  private connId: number;

  constructor(ws: HoloWorkspace, connId: number, path: string) {
    this.ws = ws;
    this.connId = connId;
    const k = new Uint8Array([...maskKey(), ...maskKey(), ...maskKey(), ...maskKey()]);
    this.key = base64(k);
    this.ws.guest_send(connId, wsHandshakeRequest(path, this.key));
  }

  private emit(type: string, ev: { type: string; data?: unknown; code?: number; reason?: string }) {
    const own = (this as unknown as Record<string, SockListener | null>)["on" + type];
    if (typeof own === "function") own(ev);
    for (const l of this.listeners[type] || []) l(ev);
  }

  /** One service step driven by the runtime pump. Returns true if it made progress. */
  service(): boolean {
    if (this.readyState === RuntimeSocket.CLOSED) return false;
    const chunk = this.ws.guest_recv(this.connId);
    const open = this.ws.guest_is_open(this.connId);
    if (chunk.length) {
      const m = new Uint8Array(this.buf.length + chunk.length);
      m.set(this.buf);
      m.set(chunk, this.buf.length);
      this.buf = m;
    } else if (open && this.upgraded) {
      return false;
    }
    if (!this.upgraded) {
      const hs = readWsHandshakeResponse(this.buf, this.key);
      if (hs.pending) return chunk.length > 0;
      if (!hs.ok) {
        this.fail("websocket handshake rejected");
        return true;
      }
      this.upgraded = true;
      this.buf = hs.rest || new Uint8Array(0);
      this.readyState = RuntimeSocket.OPEN;
      this.emit("open", { type: "open" });
    }
    const { frames, rest } = decodeWsFrames(this.buf);
    this.buf = rest;
    for (const f of frames) this.handleFrame(f);
    if (!open && this.readyState !== RuntimeSocket.CLOSED) {
      this.readyState = RuntimeSocket.CLOSED;
      this.emit("close", { type: "close", code: 1006, reason: "guest connection closed" });
      this.onClosed?.();
    }
    return true;
  }

  private handleFrame(f: WsFrame) {
    if (f.opcode === 0x8) {
      this.readyState = RuntimeSocket.CLOSED;
      this.emit("close", { type: "close", code: 1000, reason: "" });
      this.ws.guest_close(this.connId);
      this.onClosed?.();
      return;
    }
    if (f.opcode === 0x9) {
      this.ws.guest_send(this.connId, encodeWsFrame(0xa, f.payload));
      return;
    }
    if (f.opcode === 0x1) this.emit("message", { type: "message", data: new TextDecoder().decode(f.payload) });
    else if (f.opcode === 0x2) {
      const data =
        this.binaryType === "arraybuffer"
          ? f.payload.buffer.slice(f.payload.byteOffset, f.payload.byteOffset + f.payload.byteLength)
          : f.payload;
      this.emit("message", { type: "message", data });
    }
  }

  private fail(msg: string) {
    this.readyState = RuntimeSocket.CLOSED;
    this.emit("error", { type: "error", data: msg });
    this.emit("close", { type: "close", code: 1006, reason: msg });
    this.onClosed?.();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== RuntimeSocket.OPEN) throw new Error("RuntimeSocket not open");
    if (typeof data === "string") this.ws.guest_send(this.connId, encodeWsFrame(0x1, data));
    else {
      const u =
        data instanceof Uint8Array
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data as ArrayBuffer);
      this.ws.guest_send(this.connId, encodeWsFrame(0x2, u));
    }
  }

  close(): void {
    if (this.readyState === RuntimeSocket.CLOSED) return;
    this.readyState = RuntimeSocket.CLOSING;
    try {
      this.ws.guest_send(this.connId, encodeWsFrame(0x8, new Uint8Array(0)));
    } catch {
      /* already gone */
    }
    this.ws.guest_close(this.connId);
    this.readyState = RuntimeSocket.CLOSED;
    this.onClosed?.();
  }

  addEventListener(type: string, listener: SockListener): void {
    (this.listeners[type] ??= new Set()).add(listener);
  }
  removeEventListener(type: string, listener: SockListener): void {
    this.listeners[type]?.delete(listener);
  }
}
