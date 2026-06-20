// holo-static-transport.ts — the `static` transport: a no-backend shell for the content-addressed
// Pages deploy before a guest is booted. Reads answer with empty states (200, never a network error)
// and sockets are inert, so the dashboard is navigable rather than throwing. Installed by the bootstrap
// (holo-bootstrap.ts) when the frame signals a no-backend mount (`window.__HOLO_STATIC__`).
import { setFetchImpl, setSocketFactory } from "./api";

// Best-effort empty state for a dashboard-relative path. List-shaped families answer with an empty
// collection; everything else with an empty object. The shell renders "nothing yet" instead of erroring.
function emptyStateFor(path: string): unknown {
  const p = path.split("?")[0];
  // Bare-array endpoints (the response IS a JSON array): an empty array, so `.map`/`.some`/`.length`
  // and `for…of` all work in the shell. (e.g. GET /api/dashboard/plugins → PluginManifest[].)
  if (/\/(dashboard\/plugins|models|themes|fonts|toolsets|skills)\b/.test(p)) return [];
  // Wrapped-collection endpoints (the response is { items: [...] } or similar).
  if (/\/(sessions|logs|mcp|plugins|webhooks|profiles|messaging\/platforms|automation|cron)\b/.test(p)) {
    return { items: [], sessions: [], skills: [], results: [], total: 0 };
  }
  if (p.endsWith("/status")) return { ok: true, static: true };
  return {};
}

/** Install the static transport: every `/api` read returns an empty-state 200; sockets are inert. */
export function installStaticTransport(): void {
  setFetchImpl(async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return new Response(JSON.stringify(emptyStateFor(path)), {
      status: 200,
      headers: { "content-type": "application/json", "x-holo-transport": "static" },
    });
  });
  setSocketFactory((url) => new InertSocket(url) as unknown as WebSocket);
}

// A socket that stays CONNECTING forever and emits nothing — no open, no message, no close — so socket
// consumers idle quietly (no reconnect storms, no "disconnected" banners) in the no-backend shell.
class InertSocket {
  readyState = 0; // CONNECTING
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}
