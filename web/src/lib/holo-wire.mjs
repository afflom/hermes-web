// holo-wire.mjs — pure, cross-environment HTTP/1.1 + WebSocket wire codecs for the `hologram`
// transport. NO DOM / Node globals beyond TextEncoder/TextDecoder (both ambient in browser + Node),
// so the exact same bytes can be unit-tested in the BDD runner and shipped to the browser. The
// `holo-transport.ts` glue layers `fetch`/`WebSocket` semantics on top of these; here we only turn
// requests↔bytes and frames↔bytes, which is the part worth proving deterministically.
//
// Why a hand-rolled HTTP/WS client at all: the dashboard talks to `web_server.py` running INSIDE the
// in-browser RISC-V guest, reached over the emulator's in-process loopback bridge
// (holospaces-web `Workspace.dial_guest`/`guest_send`/`guest_recv`, witnessed by `CC-33`). That bridge
// is a raw TCP byte stream, not `fetch`, so the transport speaks HTTP/1.1 and RFC-6455 over it.

const te = new TextEncoder();
const td = new TextDecoder();

const concat = (chunks) => {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};
const indexOfSub = (buf, sub, from = 0) => {
  outer: for (let i = from; i <= buf.length - sub.length; i++) {
    for (let j = 0; j < sub.length; j++) if (buf[i + j] !== sub[j]) continue outer;
    return i;
  }
  return -1;
};
const CRLFCRLF = te.encode("\r\n\r\n");

// ── HTTP/1.1 ────────────────────────────────────────────────────────────────────────────────────

/** Serialize a request to HTTP/1.1 bytes. `headers` is a plain object; `body` is a string |
 * Uint8Array | undefined. Adds Host, Content-Length, and Connection: close (one request per dial). */
export function encodeHttpRequest({ method = "GET", path, headers = {}, body, host = "guest" }) {
  const bodyBytes = body == null ? new Uint8Array(0) : (typeof body === "string" ? te.encode(body) : body);
  const h = { Host: host, Connection: "close", ...headers };
  if (bodyBytes.length || method !== "GET") h["Content-Length"] = String(bodyBytes.length);
  let head = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(h)) head += `${k}: ${v}\r\n`;
  head += "\r\n";
  return concat([te.encode(head), bodyBytes]);
}

/** Parse accumulated response bytes. Returns { complete, status, statusText, headers, body } where
 * `body` is a Uint8Array. `complete` is true once the full body is present per Content-Length, or —
 * when there is no Content-Length and `closed` is set — once the connection has closed (the body is
 * then everything after the header). Chunked transfer-encoding is decoded. */
export function parseHttpResponse(buf, { closed = false } = {}) {
  const sep = indexOfSub(buf, CRLFCRLF);
  if (sep < 0) return { complete: false };
  const headText = td.decode(buf.subarray(0, sep));
  const [statusLine, ...headerLines] = headText.split("\r\n");
  const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/);
  if (!m) throw new Error("malformed status line: " + statusLine);
  const status = Number(m[1]);
  const statusText = m[2] || "";
  const headers = {};
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const rest = buf.subarray(sep + 4);
  if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
    const decoded = decodeChunked(rest);
    return decoded ? { complete: true, status, statusText, headers, body: decoded } : { complete: false };
  }
  if (headers["content-length"] != null) {
    const len = Number(headers["content-length"]);
    if (rest.length < len) return { complete: false };
    return { complete: true, status, statusText, headers, body: rest.subarray(0, len) };
  }
  // No length framing: complete only when the peer closes.
  return closed ? { complete: true, status, statusText, headers, body: rest } : { complete: false };
}

function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = indexOfSub(buf, te.encode("\r\n"), i);
    if (nl < 0) return null;
    const size = parseInt(td.decode(buf.subarray(i, nl)), 16);
    if (Number.isNaN(size)) return null;
    if (size === 0) return concat(out);
    const start = nl + 2;
    if (start + size > buf.length) return null;
    out.push(buf.subarray(start, start + size));
    i = start + size + 2; // skip chunk + trailing CRLF
  }
  return null; // no terminating 0-chunk yet
}

// ── WebSocket (RFC 6455) ──────────────────────────────────────────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Build the client opening handshake bytes for `path` with a (base64) Sec-WebSocket-Key. */
export function wsHandshakeRequest(path, key, { host = "guest", headers = {} } = {}) {
  const h = {
    Host: host, Upgrade: "websocket", Connection: "Upgrade",
    "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...headers,
  };
  let s = `GET ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(h)) s += `${k}: ${v}\r\n`;
  return te.encode(s + "\r\n");
}

/** The expected Sec-WebSocket-Accept for a given key (base64(sha1(key + GUID))). */
export function wsAcceptFor(key) {
  return base64(sha1Bytes(te.encode(key + WS_GUID)));
}

/** Verify the server's 101 handshake response; returns { ok, headers, rest } (rest = bytes after the
 * header block — the start of the frame stream). */
export function readWsHandshakeResponse(buf, key) {
  const sep = indexOfSub(buf, CRLFCRLF);
  if (sep < 0) return { ok: false, pending: true };
  const headText = td.decode(buf.subarray(0, sep));
  const [statusLine, ...lines] = headText.split("\r\n");
  const headers = {};
  for (const l of lines) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  const ok = /\s101\s/.test(statusLine) && (headers["sec-websocket-accept"] === wsAcceptFor(key));
  return { ok, headers, rest: buf.subarray(sep + 4) };
}

/** Encode a single WS frame. Client frames MUST be masked (mask defaults to 4 random-ish bytes; pass
 * a fixed mask for deterministic tests). opcode: 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong. */
export function encodeWsFrame(opcode, payload, mask) {
  const data = typeof payload === "string" ? te.encode(payload) : (payload || new Uint8Array(0));
  const len = data.length;
  const head = [0x80 | (opcode & 0x0f)];
  if (len < 126) head.push(0x80 | len);
  else if (len < 65536) head.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  else head.push(0x80 | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  const m = mask || maskKey();
  const masked = new Uint8Array(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ m[i & 3];
  return concat([new Uint8Array(head), m, masked]);
}

/** Decode as many complete frames as `buf` holds. Returns { frames:[{opcode,payload}], rest }. Server
 * frames are unmasked; we also unmask if the mask bit is set (be liberal). */
export function decodeWsFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const b0 = buf[i], b1 = buf[i + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = i + 2;
    if (len === 126) { if (off + 2 > buf.length) break; len = (buf[off] << 8) | buf[off + 1]; off += 2; }
    else if (len === 127) { if (off + 8 > buf.length) break; len = 0; for (let k = 4; k < 8; k++) len = (len * 256) + buf[off + k]; off += 8; }
    let mkey = null;
    if (masked) { if (off + 4 > buf.length) break; mkey = buf.subarray(off, off + 4); off += 4; }
    if (off + len > buf.length) break;
    let payload = buf.subarray(off, off + len);
    if (masked) { const u = new Uint8Array(len); for (let k = 0; k < len; k++) u[k] = payload[k] ^ mkey[k & 3]; payload = u; }
    frames.push({ opcode, payload });
    i = off + len;
  }
  return { frames, rest: buf.subarray(i) };
}

// ── tiny self-contained crypto / encoding (no Node/SubtleCrypto dependency) ────────────────────

export function maskKey() {
  const k = new Uint8Array(4);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(k);
  else for (let i = 0; i < 4; i++) k[i] = (i * 73 + 17) & 0xff; // deterministic fallback (tests pass an explicit mask)
  return k;
}

export function base64(bytes) {
  if (typeof btoa === "function") { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
  return Buffer.from(bytes).toString("base64");
}

/** Minimal SHA-1 (bytes → 20-byte digest). Used only for the WS handshake accept value. */
export function sha1Bytes(msg) {
  const ml = msg.length;
  const withOne = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
  withOne.set(msg);
  withOne[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, bitLen >>> 0);
  dv.setUint32(withOne.length - 8, Math.floor(bitLen / 0x100000000));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rol = (n, c) => (n << c) | (n >>> (32 - c));
  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  new DataView(out.buffer).setUint32(0, h0 >>> 0);
  new DataView(out.buffer).setUint32(4, h1 >>> 0);
  new DataView(out.buffer).setUint32(8, h2 >>> 0);
  new DataView(out.buffer).setUint32(12, h3 >>> 0);
  new DataView(out.buffer).setUint32(16, h4 >>> 0);
  return out;
}

export const _internal = { concat, indexOfSub, decodeChunked };
