// holo-protocol.ts — the message contract between the main thread and the holospaces Web Worker.
// The worker hosts the entire data plane (wasm emulator, warm-κ fetch/verify/resume, the BridgeRuntime
// pump) so the 1.44 GB warm machine never touches the main thread and the UI never blocks. The main
// thread is a thin proxy: it relays /api + WebSocket calls to the worker and shuttles the agent's egress
// frames to the router extension (chrome.runtime is main-thread only).

import type { HologramBootProgress } from "./holo-hologram-types";

/** main → worker */
export type ToWorker =
  // base = HERMES_BASE_PATH (the worker strips it from guest paths). opfs=true pages the disk into an
  // OPFS κ-store (off the wasm heap, lower memory) — opt-in, since it is currently slower (per-sector
  // OPFS I/O over the ~900 MB disk); the default monolithic resume is faster and proven.
  | { t: "boot"; base: string; opfs: boolean }
  | { t: "fetch"; rid: number; path: string; method: string; headers: Record<string, string>; body?: string }
  | { t: "wsopen"; sid: number; path: string }
  | { t: "wssend"; sid: number; data: string | ArrayBuffer; binary: boolean }
  | { t: "wsclose"; sid: number }
  | { t: "egressin"; frame: Uint8Array }; // a reply frame from the extension's sockets

/** worker → main */
export type FromWorker =
  | { t: "progress"; p: HologramBootProgress }
  | { t: "ready"; token: string; embedded: boolean; authRequired: boolean }
  | { t: "booterr"; message: string }
  | { t: "fetchres"; rid: number; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null }
  | { t: "fetcherr"; rid: number; message: string }
  | { t: "wsopened"; sid: number }
  | { t: "wsmsg"; sid: number; data: string | ArrayBuffer }
  | { t: "wsclosed"; sid: number; code: number; reason: string }
  | { t: "wserr"; sid: number; message: string }
  | { t: "egressout"; frame: Uint8Array } // a guest frame to carry to the extension
  | { t: "apiok"; ok: boolean } // background /api/status verification result
  | { t: "log"; level: "info" | "warn" | "error" | "guest"; msg: string }; // surfaced diagnostics
