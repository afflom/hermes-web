import { test, expect } from "@playwright/test";

// G5b gate: the holospaces per-transport SPLIT (PLAN.md). With ?native=1 the dashboard's HTTP /api is served by
// the NATIVE worker (real Hermes Python under Pyodide — single-threaded, fast), while realtime /api/ws (chat /
// agent) is routed to the EMULATED GUEST (the agent gateway is fundamentally threaded; real threads exist only
// in the guest's real OS, dialed over CC-33). Both ride the ONE holo-protocol the dashboard already speaks.
//
// This gate proves the ROUTING the split newly introduces — it is fast and does NOT wait on the guest's
// one-time >360s first-ASGI establishment (an orthogonal, known perf item fixed by re-banking a
// post-establishment κ; the guest's serving of the threaded gateway is itself already covered by the emulated
// path's own e2e). Specifically:
//   1. the dashboard comes up native-fast and serves real /api WITHOUT waiting on the guest;
//   2. the chat socket is routed through the worker protocol to the guest — NOT a real `new WebSocket` against
//      the origin (the bug the early-installed factory fixes);
//   3. the guest worker boots in the background (κ-resume) so the agent transport will come online.

declare global {
  interface Window {
    __HOLO_BACKEND_READY__?: boolean;   // HTTP (native) backend serving the dashboard
    __HOLO_AGENT_READY__?: boolean;     // WS (guest) backend κ-resumed
    __HOLO_FETCH__?: (path: string, init?: RequestInit) => Promise<Response>;
    __HOLO_WS__?: (path: string) => { readyState: number; close(): void };
  }
}

test("native+guest split: dashboard native-fast, chat routed to the guest worker (not the origin)", async ({ page }) => {
  test.setTimeout(300_000);
  const originWsErrors: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    console.log(`[browser:${m.type()}] ${t}`);
    // A real WebSocket against the origin server (the pre-fix fallback) logs exactly this. The split must route
    // chat through the worker instead, so this MUST NOT appear.
    if (/WebSocket connection to 'wss?:\/\/[^']*\/api\/(ws|events|pty)/i.test(t)) originWsErrors.push(t);
  });
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));

  await page.goto("./?native=1", { waitUntil: "load" });

  // 1. The dashboard HTTP backend (native) comes up FIRST and independently of the multi-minute guest resume.
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 120_000 });
  const cfg = await page.evaluate(async () => {
    const r = await window.__HOLO_FETCH__!("/api/config");
    return { status: r.status, len: (await r.text()).length };
  });
  expect(cfg.status, "GET /api/config served natively (HTTP→native), no guest needed").toBe(200);
  expect(cfg.len).toBeGreaterThan(100);

  // 2. Opening the chat socket routes through the worker protocol — it constructs a WorkerSocket (queued until
  //    the guest warms), NOT a real `new WebSocket` to the origin. readyState CONNECTING(0) confirms a live
  //    socket object (not a thrown/failed origin connection).
  const rs = await page.evaluate(() => {
    const ws = window.__HOLO_WS__!("/api/ws");
    const state = ws.readyState;
    return state;
  });
  expect(rs, "chat socket is a live WorkerSocket (CONNECTING), not an origin WebSocket").toBe(0);

  // 3. The guest worker boots in the background (κ-resume) — the agent transport will come online once it warms.
  await page.waitForFunction("window.__HOLO_AGENT_READY__ === true", null, { timeout: 280_000 });

  // The dashboard ran the whole time with NO real origin WebSocket attempt — chat stayed on the worker route.
  expect(originWsErrors, `chat must route to the guest worker, not the origin server:\n${originWsErrors.join("\n")}`).toEqual([]);

  // The dashboard is still rendering native data (no backend error state).
  const body = await page.locator("body").innerText();
  expect(body, "dashboard not in an error state").not.toMatch(/failed to load|error loading|backend unavailable/i);
});
