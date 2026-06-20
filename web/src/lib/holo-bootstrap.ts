// holo-bootstrap.ts — select and install the dashboard data transport at startup.
//
//   static   the static Pages build (no backend) → empty-state reads + inert sockets
//            (holo-static-transport.ts), so the dashboard renders its no-backend landing instead of
//            404-ing every /api call.
//   origin   a server-hosted build (the real `hermes dashboard` backend) → today's HTTP-to-/api
//            transport, completely unchanged (the default).
import { installStaticTransport } from "./holo-static-transport";

/** Build-time flag (Vite `define`): true in the static Pages build (`HERMES_HOLO_BASE` set). That build
 * has no co-located backend, so it installs the static transport; the server build leaves it false →
 * `origin` (the real Python backend). */
declare const __HERMES_HOLO_BUILD__: boolean;

export type TransportMode = "static" | "origin";

/** Select + install the dashboard transport. Returns the chosen mode. Call once, before render. */
export function selectHoloTransport(): TransportMode {
  if (typeof window === "undefined") return "origin";
  if (typeof __HERMES_HOLO_BUILD__ !== "undefined" && __HERMES_HOLO_BUILD__) {
    installStaticTransport();
    return "static";
  }
  return "origin";
}
