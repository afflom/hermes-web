// holo-egress.ts — the agent's window to the internet. The in-browser guest's outbound traffic (the
// Hermes agent calling model APIs, cloning git, pip/npm, any socket) leaves its NAT as opaque egress
// frames (OPEN/DATA/CLOSE, multiplexed by connection id) that the wasm hands us via
// `Workspace.egress_outbound()`; replies go back via `Workspace.egress_inbound()`. A browser tab can't
// open raw sockets, so those frames are carried to the real internet by the **holospaces router
// extension** (Direct Sockets `TCPSocket`) — the serverless egress gateway, overcoming the browser's
// network sandbox / CORS with no relay server.
//
// This module is the page-side connector to that extension (mirrors holospaces' `extension/connector.js`,
// typed): detect it (it announces itself on our origin), open the egress port, and shuttle the opaque
// frames. The frame *format* is the substrate's concern — we never parse it; we only carry it.

/** The extension marks our page via a content script at document_start (`content.js`):
 *  `<html data-holospaces-egress="<extension-id>">`. Reading it both detects the extension AND yields
 *  the id needed to open the port. Returns the id, or null if the extension isn't installed. */
export function detectEgressExtensionId(): string | null {
  if (typeof document === "undefined") return null;
  const id = document.documentElement.getAttribute("data-holospaces-egress");
  return id && id.length > 0 ? id : null;
}

/** Ask the content script to (re-)announce, then resolve the id once present or after a short timeout.
 *  Handles the race where the page probes before the content script has run. */
export function awaitEgressExtensionId(timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const immediate = detectEgressExtensionId();
    if (immediate) return resolve(immediate);
    if (typeof window === "undefined") return resolve(null);

    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      obs?.disconnect();
      clearTimeout(timer);
      resolve(v);
    };
    // The content script re-announces on this event (it may run after us).
    try {
      window.dispatchEvent(new Event("holospaces-egress-probe"));
    } catch {
      /* non-DOM context */
    }
    const obs =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            const id = detectEgressExtensionId();
            if (id) finish(id);
          })
        : null;
    obs?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-holospaces-egress"] });
    const timer = setTimeout(() => finish(detectEgressExtensionId()), timeoutMs);
  });
}

// The router-extension version THIS build of hermes-web requires (the version it bundles under
// public/holo/extension). An installed extension older than this — or one too old to announce a version
// at all — is treated as incompatible and the operator is prompted to reinstall the bundled build.
export const REQUIRED_EXTENSION_VERSION = "0.1.0";

/** The installed extension's announced version (`data-holospaces-egress-version`), or null. */
export function detectEgressExtensionVersion(): string | null {
  if (typeof document === "undefined") return null;
  const v = document.documentElement.getAttribute("data-holospaces-egress-version");
  return v && v.length > 0 ? v : null;
}

/** Dotted-version compare: true iff `have` >= `need` (e.g. "0.1.0" >= "0.1.0"). */
export function versionAtLeast(have: string, need: string): boolean {
  const h = have.split(".").map((n) => parseInt(n, 10) || 0);
  const n = need.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(h.length, n.length); i++) {
    const a = h[i] ?? 0;
    const b = n[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Compatibility state of the router extension on this page: absent, installed-but-outdated, or ok. */
export function egressExtensionStatus(): "absent" | "outdated" | "ok" {
  if (detectEgressExtensionId() == null) return "absent";
  const v = detectEgressExtensionVersion();
  if (v == null || !versionAtLeast(v, REQUIRED_EXTENSION_VERSION)) return "outdated";
  return "ok";
}

/** Whether this browser could talk to an installed extension at all (Chromium with `chrome.runtime`). */
export function egressRuntimeAvailable(): boolean {
  const c = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome;
  return !!c?.runtime?.connect;
}

/** The opaque egress channel to the extension: `send` a guest frame, `onFrame` receive the host's
 *  replies, `close` to tear down (the extension drops every socket this tab owned). */
export interface EgressChannel {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  close(): void;
}

interface ChromePort {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}
interface ChromeRuntime {
  connect(extensionId: string, info?: { name?: string }): ChromePort;
}

function chromeRuntime(): ChromeRuntime | null {
  const c = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return c?.runtime ?? null;
}

/** Open the egress port to the extension. The framing is exactly what holospaces sends a node over a
 *  WebSocket (`wsnet.rs`); the carrier is a `chrome.runtime` port instead. Returns null if unreachable. */
export function connectEgress(extensionId: string): EgressChannel | null {
  const runtime = chromeRuntime();
  if (!runtime || !extensionId) return null;
  let port: ChromePort;
  try {
    port = runtime.connect(extensionId);
  } catch {
    return null;
  }
  const listeners: ((f: Uint8Array) => void)[] = [];
  port.onMessage.addListener((msg: unknown) => {
    // The extension posts frames as a plain number[] (structured clone of bytes); normalise to bytes.
    const f = msg instanceof Uint8Array ? msg : Uint8Array.from(msg as number[]);
    for (const cb of listeners) cb(f);
  });
  return {
    send: (frame) => port.postMessage(Array.from(frame)),
    onFrame: (cb) => listeners.push(cb),
    close: () => {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
