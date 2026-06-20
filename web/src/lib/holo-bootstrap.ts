// holo-bootstrap.ts — select the dashboard data transport at startup.
//
//   hologram  the Pages build (`HERMES_HOLO_BASE` set) → the real Hermes `web_server.py` runs in an
//             in-browser content-addressed RISC-V guest (holospaces-web wasm); the dashboard's /api +
//             WebSocket calls reach it over the emulator's loopback bridge. The warm machine is RESUMED
//             from a banked κ (no cold boot), with the guest disk paged from the OPFS κ-store. This is
//             async (`bootHologramTransport`, driven by the boot UI in `main.tsx`). There is no fake
//             fallback: if the in-browser backend cannot come up it is an honest error, not fabricated
//             empty data — the data plane is holospaces or nothing.
//   origin    a server-hosted build (the real `hermes dashboard` backend) → today's HTTP-to-/api
//             transport, unchanged (the default; this is the real Python backend, not a stand-in).
declare const __HERMES_HOLO_BUILD__: boolean;

export type TransportMode = "hologram" | "origin";

/** Decide the transport for this build/runtime, WITHOUT performing the async hologram boot. The Pages
 * build chooses `hologram`; a server-hosted build is `origin` (the default HTTP-to-/api transport,
 * installed implicitly by `api.ts`). Call before render to know whether the boot UI is needed. */
export function selectTransportMode(): TransportMode {
  if (typeof window === "undefined") return "origin";
  if (typeof __HERMES_HOLO_BUILD__ !== "undefined" && __HERMES_HOLO_BUILD__) return "hologram";
  return "origin";
}
