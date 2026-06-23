// Native egress gateway for the e2e suite — the existing "native install" pattern (extension/egress-test.mjs)
// bridged into a Playwright page so the EGRESS-tier dashboard tabs (Models / MCP / Channels / Skills / the
// agent Chat) run with REAL outbound network instead of being skipped. In production the page's egress
// connector (holo-egress.connectEgress) talks to the chrome router extension over chrome.runtime + Direct
// Sockets; here we host the SHIPPED extension service worker (web/public/holo/extension/background.js) in the
// node test process with Direct Sockets faithfully polyfilled by node:net, and bridge the page<->worker
// chrome.runtime port over Playwright bindings. To the dashboard it is indistinguishable from the installed
// extension: it announces itself (data-holospaces-egress) and carries the guest's OPEN/DATA/CLOSE frames to
// the real internet.

import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const EXT_BACKGROUND = path.resolve(dir, "../web/public/holo/extension/background.js");

/** Load the shipped extension service worker once into this process (Direct Sockets → node:net), returning
 *  the captured onConnectExternal handler. */
function loadExtension() {
  const connectHandlers = [];
  globalThis.TCPSocket = class {
    constructor(host, port) {
      const sock = net.connect(port, host);
      this._sock = sock;
      sock.on("error", () => {}); // the protocol reports failures (OP_FAILED/CLOSED); never leave it unhandled
      this.opened = new Promise((resolve, reject) => {
        sock.once("error", reject);
        sock.once("connect", () => {
          const readable = new ReadableStream({
            start(ctrl) {
              sock.on("data", (d) => { try { ctrl.enqueue(new Uint8Array(d)); } catch { /* closed */ } });
              const fin = () => { try { ctrl.close(); } catch { /* closed */ } };
              sock.on("end", fin); sock.on("close", fin); sock.on("error", fin);
            },
            cancel() { try { sock.destroy(); } catch { /* gone */ } },
          });
          const writable = new WritableStream({
            write(chunk) { return new Promise((res) => sock.write(chunk, () => res())); },
            close() { try { sock.end(); } catch { /* gone */ } },
            abort() { try { sock.destroy(); } catch { /* gone */ } },
          });
          resolve({ readable, writable });
        });
      });
    }
    close() { try { this._sock.destroy(); } catch { /* gone */ } }
  };
  globalThis.chrome = {
    runtime: {
      onConnectExternal: { addListener: (h) => connectHandlers.push(h) },
      onMessageExternal: { addListener: () => {} },
    },
    permissions: { request: async () => true },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(EXT_BACKGROUND, "utf8"));
  return connectHandlers;
}

/**
 * Install the native egress gateway on a Playwright page (call BEFORE page.goto). Returns a stats handle:
 *   { opens, frames } — how many OPEN frames / total frames the guest sent through the gateway (proof the
 *   full chain guest→worker→client→extension carried real egress).
 */
export async function installNativeEgressGateway(page) {
  const connectHandlers = loadExtension();
  const stats = { opens: 0, frames: 0, ports: 0 };
  const extPorts = new Map(); // page port id -> the extension-side FakePort

  // node → page: deliver a reply frame to the page's chrome port.
  const deliver = (pid, msg) =>
    page.evaluate(({ pid, msg }) => window.__egressFromGw(pid, msg), { pid, msg: Array.from(msg) }).catch(() => {});

  await page.exposeFunction("__egressOpen", (pid) => {
    stats.ports++;
    const ext = {
      name: "egress",
      _msg: [],
      _disc: [],
      postMessage: (msg) => deliver(pid, msg),
      onMessage: { addListener: (cb) => ext._msg.push(cb) },
      onDisconnect: { addListener: (cb) => ext._disc.push(cb) },
    };
    extPorts.set(pid, ext);
    connectHandlers[0](ext); // the extension's egress role attaches
  });
  await page.exposeFunction("__egressToGw", (pid, frame) => {
    const ext = extPorts.get(pid);
    if (!ext) return;
    stats.frames++;
    if (frame && frame[0] === 0x01) stats.opens++; // OP_OPEN — the guest dialed an outbound host
    ext._msg.forEach((cb) => cb(frame));
  });
  await page.exposeFunction("__egressClose", (pid) => {
    const ext = extPorts.get(pid);
    if (ext) ext._disc.forEach((cb) => cb());
    extPorts.delete(pid);
  });

  // page side (document_start): a fake chrome.runtime whose port bridges to the node-hosted extension, plus
  // the extension's self-announcement so holo-egress's detector wires egress on for this page.
  await page.addInitScript(() => {
    const ports = new Map();
    let next = 1;
    window.__egressFromGw = (pid, msg) => (ports.get(pid) || []).forEach((cb) => cb(msg));
    const fakeRuntime = {
      connect: (_extId, info) => {
        const pid = next++;
        const ls = [];
        ports.set(pid, ls);
        window.__egressOpen(pid);
        return {
          name: (info && info.name) || "egress",
          postMessage: (m) => window.__egressToGw(pid, m),
          onMessage: { addListener: (cb) => ls.push(cb) },
          onDisconnect: { addListener: () => {} },
          disconnect: () => window.__egressClose(pid),
        };
      },
    };
    try {
      // Chromium pages already expose a (connect-less) `chrome`; add our runtime.connect without clobbering.
      const c = window.chrome || {};
      c.runtime = Object.assign({}, c.runtime, fakeRuntime);
      Object.defineProperty(window, "chrome", { value: c, configurable: true, writable: true });
    } catch {
      window.chrome = { runtime: fakeRuntime };
    }
    const announce = () => {
      const e = document.documentElement;
      if (!e) return;
      e.setAttribute("data-holospaces-egress", "native-gw");
      e.setAttribute("data-holospaces-egress-version", "0.1.0");
    };
    announce();
    window.addEventListener("holospaces-egress-probe", announce);
  });

  return stats;
}
