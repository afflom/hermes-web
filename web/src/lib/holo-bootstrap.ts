// holo-bootstrap.ts — select and install the dashboard transport at startup. Three modes, chosen by
// the signals the holospace launcher injects into the mounted iframe; the default is origin
// (server-hosted, completely unchanged — no signal, no deviation):
//
//   hologram  window.__HOLO_GUEST_BRIDGE__ present  → route /api + sockets to the in-guest
//             web_server.py over the emulator loopback bridge (holo-transport.ts). Warm-start (HL-6)
//             is transparent here: the launcher injects the SAME bridge whether the guest cold-booted
//             or was resumed instantly from its OPFS κ-snapshot (CC-30, resume_devcontainer_bridged),
//             so this seam needs no resume-specific branch — a resumed dashboard dials identically.
//   static    window.__HOLO_STATIC__ === true        → no-backend shell: empty-state reads, inert
//             sockets (holo-static-transport.ts) — the navigable Pages shell before a guest boots.
//   origin    neither signal                         → today's HTTP-to-/api transport (default).
import { fromWorkspace, installHologramTransport } from "./holo-transport";
import { installStaticTransport } from "./holo-static-transport";

/** Build-time flag (Vite `define`): true only in the holospace app-object build (`HERMES_HOLO_BASE`).
 * That build is mounted in the os-holo frame with no co-located backend, so with no guest bridge it
 * renders the static shell rather than 404-ing `/api` against the static host. False in the server build
 * (→ `origin`, the real Python backend). */
declare const __HERMES_HOLO_BUILD__: boolean;

declare global {
  interface Window {
    /** The holospaces-web `Workspace` handle the launcher injects once a guest is booted (the
     * snake_case wasm-bindgen surface the hologram transport dials). */
    __HOLO_GUEST_BRIDGE__?: Parameters<typeof fromWorkspace>[0];
    /** The guest port `web_server.py` listens on (default 9119). */
    __HOLO_GUEST_PORT__?: number;
    /** Set when the app is mounted with no backend (the content-addressed Pages shell). */
    __HOLO_STATIC__?: boolean;
  }
}

export type TransportMode = "hologram" | "static" | "origin";

/** Select + install the dashboard transport. Returns the chosen mode. Call once, before render. */
export function selectHoloTransport(): TransportMode {
  if (typeof window === "undefined") return "origin";
  const bridge = window.__HOLO_GUEST_BRIDGE__;
  if (bridge) {
    installHologramTransport(fromWorkspace(bridge), {
      port: window.__HOLO_GUEST_PORT__ ?? 9119,
    });
    return "hologram";
  }
  if (window.__HOLO_STATIC__) {
    installStaticTransport();
    return "static";
  }
  // The holospace app-object build has no co-located /api backend; with no guest bridge yet, render the
  // static navigable shell instead of 404-ing against the static host's origin. (Server build: origin.)
  if (typeof __HERMES_HOLO_BUILD__ !== "undefined" && __HERMES_HOLO_BUILD__) {
    installStaticTransport();
    return "static";
  }
  return "origin";
}
