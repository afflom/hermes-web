import { test, expect } from "@playwright/test";

// G4 gate: the native-exec backend serves the dashboard's /api IN THE BROWSER — the real, unmodified Hermes
// Python on the browser peer's own JS engine (Pyodide), reached over the same holo-protocol the dashboard
// already uses (DRY). Opt-in via ?native=1 during the transition. Reads + writes must round-trip native-fast
// (the emulated interpreter wall took >360 s).

declare global {
  interface Window {
    __HOLO_BACKEND_READY__?: boolean;
    __HOLO_FETCH__?: (path: string, init?: RequestInit) => Promise<Response>;
  }
}

test("native-exec backend serves real /api reads + writes in the browser", async ({ page }) => {
  test.setTimeout(360_000);
  page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));

  await page.goto("./?native=1", { waitUntil: "load" });
  // Native boot: Pyodide (CDN) + the Hermes bundle + micropip deps. Far smaller than the 377 MB κ, but the
  // first dep fetch is network-bound — allow generous time.
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 300_000 });

  // A real /api read through the full FastAPI stack, native.
  const cfg = await page.evaluate(async () => {
    const r = await window.__HOLO_FETCH__!("/api/config");
    return { status: r.status, len: (await r.text()).length };
  });
  expect(cfg.status, "GET /api/config served natively").toBe(200);
  expect(cfg.len).toBeGreaterThan(100);

  // A real local MUTATION round-trips native (create cron job → list → delete).
  const rt = await page.evaluate(async () => {
    const mk = await window.__HOLO_FETCH__!("/api/cron/jobs?profile=default", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "native_e2e_job", prompt: "x", schedule: "0 9 * * 1" }),
    });
    const id = (await mk.json()).id as string;
    const listed = (await (await window.__HOLO_FETCH__!("/api/cron/jobs?profile=default")).text()).includes("native_e2e_job");
    await window.__HOLO_FETCH__!(`/api/cron/jobs/${id}?profile=default`, { method: "DELETE" });
    return { mkStatus: mk.status, listed };
  });
  expect(rt.mkStatus, "cron create accepted").toBeLessThan(300);
  expect(rt.listed, "the write persisted + read back, all native").toBe(true);

  // The dashboard UI renders real data over the native backend (no error state).
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0", null, { timeout: 30_000 });
  const body0 = await page.locator("body").innerText();
  expect(body0, "dashboard must not show a backend load error").not.toMatch(/failed to load|error loading|couldn.t (load|reach)|backend unavailable/i);

  // Every LOCAL dashboard tab loads native (click each sidebar link; assert its panel mounts with no error).
  for (const route of ["/sessions", "/files", "/config", "/cron", "/logs", "/env", "/system"]) {
    const link = page.locator(`a[href$="${route}"]`).first();
    if ((await link.count()) === 0) continue;
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.click({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
    const body = await page.locator("body").innerText();
    expect(body, `${route}: no backend load error native`).not.toMatch(/failed to load|error loading|backend unavailable/i);
    console.log(`[native] tab ${route} rendered native`);
  }
});
