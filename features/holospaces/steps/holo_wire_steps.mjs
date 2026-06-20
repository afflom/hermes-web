// Step definitions for the hologram wire protocol — the exact HTTP/1.1 + WebSocket bytes the
// `hologram` transport exchanges with the in-guest web_server.py over the loopback bridge. These run
// the real codec (web/src/lib/holo-wire.mjs) against a mock in-guest server, so the transport contract
// is proven deterministically without a booted guest.
import { existsSync, readFileSync } from "node:fs";
import * as wire from "../../../web/src/lib/holo-wire.mjs";

const { Given, When, Then, And } = globalThis.__bdd;
const te = new TextEncoder();
const td = new TextDecoder();
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── REST over the byte stream ─────────────────────────────────────────────────────────────────

Given("a mock in-guest web_server replying {int} with body {string} to {string}", (w, code, body, path) => {
  w.guest = (reqBytes) => {
    const reqLine = td.decode(reqBytes).split("\r\n")[0];
    assert(reqLine.includes(` ${path} `) || reqLine.includes(` ${path}?`), `request was not for ${path}: ${reqLine}`);
    return te.encode(`HTTP/1.1 ${code} OK\r\nContent-Type: application/json\r\nContent-Length: ${te.encode(body).length}\r\n\r\n${body}`);
  };
});

Given("a mock in-guest web_server replying chunked {string} to {string}", (w, body, path) => {
  w.guest = () => {
    const chunks = [body.slice(0, 5), body.slice(5)].filter(Boolean);
    let s = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    for (const c of chunks) s += `${te.encode(c).length.toString(16)}\r\n${c}\r\n`;
    return te.encode(s + "0\r\n\r\n");
  };
});

When("the dashboard sends a {word} {string} through the wire codec", (w, method, path) => {
  const req = wire.encodeHttpRequest({ method, path, headers: { Accept: "application/json" } });
  w.resp = wire.parseHttpResponse(w.guest(req), { closed: true });
});

When("the dashboard reads the response through the wire codec", (w) => {
  w.resp = wire.parseHttpResponse(w.guest(new Uint8Array()), { closed: true });
});

Then("the decoded response status is {int}", (w, code) => {
  assert(w.resp.complete, "response not complete");
  assert(w.resp.status === Number(code), `status ${w.resp.status} ≠ ${code}`);
});

Then("the decoded response body is {string}", (w, body) => {
  assert(td.decode(w.resp.body) === body, `body ${JSON.stringify(td.decode(w.resp.body))} ≠ ${JSON.stringify(body)}`);
});

// ── WebSocket over the byte stream ────────────────────────────────────────────────────────────

Given("a mock in-guest web_server that accepts the websocket upgrade for {string}", (w, path) => {
  w.wsPath = path;
});

When("the dashboard performs the websocket handshake through the wire codec", (w) => {
  w.wsKey = wire.base64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  const req = wire.wsHandshakeRequest(w.wsPath, w.wsKey);
  const reqLine = td.decode(req).split("\r\n")[0];
  assert(reqLine.includes(`GET ${w.wsPath} `), `handshake not for ${w.wsPath}`);
  // mock guest replies 101 with the correct accept
  const reply = te.encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wire.wsAcceptFor(w.wsKey)}\r\n\r\n`);
  w.hs = wire.readWsHandshakeResponse(reply, w.wsKey);
});

Then("the handshake is accepted", (w) => {
  assert(w.hs.ok, "handshake not accepted (bad Sec-WebSocket-Accept or status)");
});

When("the dashboard sends the text frame {string}", (w, text) => {
  // client frames MUST be masked; the (mock) guest unmasks and reads them
  const frame = wire.encodeWsFrame(0x1, text, new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4]));
  const { frames } = wire.decodeWsFrames(frame);
  assert(td.decode(frames[0].payload) === text, "client frame did not round-trip through masking");
});

// Build an UNMASKED server text frame (per RFC 6455, server→client frames are not masked).
function unmaskedTextFrame(text) {
  const data = new TextEncoder().encode(text);
  if (data.length >= 126) throw new Error("test frame too large");
  return new Uint8Array([0x81, data.length, ...data]); // FIN+text, no mask bit
}

When("the guest echoes a text frame {string}", (w, text) => {
  w.guestEcho = unmaskedTextFrame(text);
});

Then("the dashboard decodes the text frame {string}", (w, text) => {
  const { frames } = wire.decodeWsFrames(w.guestEcho);
  assert(frames.length >= 1, "no frame decoded");
  assert(frames[0].opcode === 0x1 && td.decode(frames[0].payload) === text, `decoded ${JSON.stringify(td.decode(frames[0].payload))} ≠ ${JSON.stringify(text)}`);
});

Then("a partial frame yields no message until complete", (w) => {
  const full = unmaskedTextFrame("complete-message");
  const partial = full.subarray(0, full.length - 3);
  assert(wire.decodeWsFrames(partial).frames.length === 0, "partial frame was decoded prematurely");
  assert(wire.decodeWsFrames(full).frames.length === 1, "complete frame failed to decode");
});

// ── transport module surface (static; the glue that installs the codec) ─────────────────────────

Given("the hologram transport module", (w) => {
  assert(existsSync("web/src/lib/holo-transport.ts"), "holo-transport.ts missing");
  w.transport = readFileSync("web/src/lib/holo-transport.ts", "utf8");
});

Then("it defines {string}", (w, sym) => {
  assert(new RegExp(`export (function|class|interface) ${sym}\\b`).test(w.transport), `holo-transport.ts does not define ${sym}`);
});

Then("the api.ts REST seam exports {string}", (w, sym) => {
  const api = readFileSync("web/src/lib/api.ts", "utf8");
  assert(new RegExp(`export function ${sym}\\b`).test(api), `api.ts does not export ${sym}`);
});
