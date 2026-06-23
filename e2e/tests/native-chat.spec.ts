import { test, expect } from "@playwright/test";

// All-native gate: with ?native=1 the WHOLE backend runs NATIVE in one Pyodide worker — the dashboard HTTP AND
// the threaded tui_gateway agent WS — no emulator (so none of its cost: 128s boot, 377MB κ, >360s
// establishment). The node gate proves the runtime + cooperative thread surface; THIS proves the same code runs
// under BROWSER Pyodide: the dashboard serves /api native, and the chat WebSocket reaches the real threaded
// gateway (handshake + a real JSON-RPC dispatch) entirely in-process — the holospaces native-exec endpoint.

declare global {
  interface Window {
    __HOLO_BACKEND_READY__?: boolean;
    __HOLO_FETCH__?: (path: string, init?: RequestInit) => Promise<Response>;
    __HOLO_WS__?: (path: string) => {
      send(data: string): void;
      addEventListener(t: string, l: (ev: { data?: unknown }) => void): void;
      close(): void;
    };
  }
}

test("all-native: ?native=1 serves the dashboard AND the threaded agent gateway native (browser Pyodide)", async ({ page }) => {
  test.setTimeout(180_000);
  page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));

  await page.goto("./?native=1", { waitUntil: "load" });

  // 1. The dashboard HTTP backend (native Pyodide) serves /api — fast, no emulator.
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 120_000 });
  const cfg = await page.evaluate(async () => {
    const r = await window.__HOLO_FETCH__!("/api/config");
    return { status: r.status, len: (await r.text()).length };
  });
  expect(cfg.status, "GET /api/config served natively").toBe(200);
  expect(cfg.len).toBeGreaterThan(100);

  // 2. The chat WebSocket reaches the REAL threaded gateway IN-PROCESS: gateway.ready handshake + a real
  //    JSON-RPC dispatch (session.list) round-trip. This is the threaded agent running native under browser
  //    Pyodide (the cooperative thread surface carrying server.dispatch + its Event/Lock/queue waits).
  const res = await page.evaluate(
    () =>
      new Promise<{ ready: boolean; replied: boolean }>((resolve, reject) => {
        const ws = window.__HOLO_WS__!("/api/ws");
        let ready = false;
        const timer = setTimeout(() => reject(new Error(`no dispatch reply in 90s (ready=${ready})`)), 90_000);
        ws.addEventListener("message", (ev) => {
          const data = typeof ev.data === "string" ? ev.data : "";
          let m: { params?: { type?: string }; id?: number; result?: unknown; error?: unknown };
          try { m = JSON.parse(data); } catch { return; }
          if (m.params?.type === "gateway.ready") {
            ready = true;
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }));
          } else if (m.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve({ ready, replied: m.result !== undefined || m.error !== undefined });
          }
        });
        ws.addEventListener("error", (ev) => { clearTimeout(timer); reject(new Error(`ws error: ${String(ev.data ?? "")}`)); });
      }),
  );
  expect(res.ready, "the native gateway emitted gateway.ready over the chat WS").toBe(true);
  expect(res.replied, "a real JSON-RPC dispatch round-tripped through the native threaded gateway").toBe(true);

  // The dashboard is rendering native data (no backend error state).
  const body = await page.locator("body").innerText();
  expect(body, "dashboard not in an error state").not.toMatch(/failed to load|error loading|backend unavailable/i);
});
