// holo-bootstrap.ts — select the dashboard data transport at startup.
//
//   hologram  the Pages build (`HERMES_HOLO_BASE` set) → the real Hermes `web_server.py` runs in an
//             in-browser content-addressed RISC-V guest (holospaces-web wasm); the dashboard's /api +
//             WebSocket calls reach it over the emulator's loopback bridge. The warm machine is RESUMED
//             from a banked κ (no cold boot). This is async (`bootHologramTransport`, driven by the
//             boot UI in `main.tsx`); if it can't run (no warm-κ published, or the runtime is
//             unavailable) it degrades to `static`.
//   static    the no-backend fallback → empty-state reads + inert sockets (`holo-static-transport.ts`),
//             so the dashboard chrome still renders its empty states instead of 404-ing every /api call.
//   origin    a server-hosted build (the real `hermes dashboard` backend) → today's HTTP-to-/api
//             transport, unchanged (the default).
import { installStaticTransport } from "./holo-static-transport";

/** Build-time flag (Vite `define`): true in the Pages build (`HERMES_HOLO_BASE` set). That build runs
 * the in-browser holospaces backend; the server build leaves it false → `origin`. */
declare const __HERMES_HOLO_BUILD__: boolean;

export type TransportMode = "hologram" | "static" | "origin";

/** Decide the transport for this build/runtime, WITHOUT performing the async hologram boot. The Pages
 * build chooses `hologram`; everything else is `origin` (the default HTTP-to-/api transport, installed
 * implicitly by `api.ts`). Call before render to know whether the boot UI is needed. */
export function selectTransportMode(): TransportMode {
  if (typeof window === "undefined") return "origin";
  if (typeof __HERMES_HOLO_BUILD__ !== "undefined" && __HERMES_HOLO_BUILD__) return "hologram";
  return "origin";
}

/** Install the static empty-state transport — the no-backend fallback used when the in-browser backend
 * can't be brought up. Renders the real dashboard chrome with empty states (never a stub placeholder). */
export function installStaticFallback(): void {
  installStaticTransport();
}
