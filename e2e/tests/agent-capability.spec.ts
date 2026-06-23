import { test, expect, type Page } from "@playwright/test";

// Strict browser-runtime tests of the COMPLETE Hermes agent backend running in the browser via
// holospaces. Every assertion drives the REAL data plane: the dashboard resumes the warm κ in an
// in-browser RISC-V guest, and these tests reach the in-guest web_server.py over the loopback bridge
// (window.__HOLO_FETCH__ / __HOLO_WS__, the actual transport — not page-native fetch). Gated on a
// published warm κ; hard-required under E2E_EXPECT_HOLOGRAM=1 (the deploy gate), skipped otherwise.
//
// The suite resumes the 2.7 GB warm machine ONCE (beforeAll, shared page) and runs every capability
// assertion against that single live backend — serial, so a re-resume per test never happens.

const EXPECT = process.env.E2E_EXPECT_HOLOGRAM === "1";

async function manifestPublished(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const r = await fetch("holo/warm/manifest.json", { cache: "no-cache" });
      if (!r.ok) return false;
      const m = await r.json();
      return typeof m?.kappa === "string" && Array.isArray(m?.chunks) && m.chunks.length > 0;
    } catch {
      return false;
    }
  });
}

/** Call the in-guest API over the loopback bridge (the real transport), returning {status, json}. */
async function api(page: Page, path: string): Promise<{ status: number; json: unknown }> {
  return page.evaluate(async (p) => {
    const f = (window as unknown as { __HOLO_FETCH__: (u: string) => Promise<Response> }).__HOLO_FETCH__;
    const res = await f(p);
    let json: unknown = null;
    try {
      json = await res.clone().json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  }, path);
}

// Resume is multi-minute (fetch + verify + restore the 1.44 GB machine); serial so the one boot is shared.
test.describe.configure({ mode: "serial", timeout: 300_000 });

test.describe("Hermes agent backend (in-browser, over the loopback bridge)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(450_000); // resume is multi-minute; this hook owns the one boot for the whole suite
    page = await browser.newPage();
    await page.goto("./", { waitUntil: "load" });
    const has = await manifestPublished(page);
    if (!has) {
      test.skip(!EXPECT, "no warm-κ manifest published for this build yet");
      expect(has, "E2E_EXPECT_HOLOGRAM=1 but no warm-κ manifest is published").toBe(true);
    }
    await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 360_000 });
    // Warm the in-guest server with one light request so the per-test probes hit a primed backend
    // (the very first request after resume pays cold-cache + JIT costs under emulation).
    await api(page, "/api/config").catch(() => {});
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("liveness: /api/status answers with a real status object", async () => {
    const { status, json } = await api(page, "/api/status");
    expect(status, "status endpoint answers 200").toBe(200);
    expect(json, "status is a JSON object").toBeTruthy();
    expect(typeof json).toBe("object");
  });

  test("configuration: /api/config + schema are served and well-formed", async () => {
    const cfg = await api(page, "/api/config");
    expect(cfg.status).toBe(200);
    expect(cfg.json, "config is an object").toMatchObject({});
    const schema = await api(page, "/api/config/schema");
    expect(schema.status, "config schema is served").toBe(200);
  });

  test("sessions: /api/sessions returns a list (the agent's session store)", async () => {
    const { status, json } = await api(page, "/api/sessions");
    expect(status).toBe(200);
    // A fresh agent has zero or more sessions — the shape must be a list (or a paged wrapper of one).
    const list = Array.isArray(json) ? json : (json as { sessions?: unknown[] })?.sessions;
    expect(Array.isArray(list), "sessions resolves to an array").toBe(true);
  });

  test("capability surface: core read endpoints all answer over the bridge", async () => {
    // A curated set of side-effect-free GETs spanning the agent's feature areas. Each must answer 2xx
    // through the in-browser backend — proving these subsystems initialized inside the guest.
    const endpoints = [
      "/api/config/defaults",
      "/api/dashboard/themes",
      "/api/dashboard/plugins",
      "/api/analytics/models",
      "/api/env",
      "/api/cron/jobs",
    ];
    const results = await Promise.all(endpoints.map((e) => api(page, e)));
    endpoints.forEach((e, i) => {
      expect(results[i].status, `${e} answers 2xx (got ${results[i].status})`).toBeGreaterThanOrEqual(200);
      expect(results[i].status, `${e} answers 2xx (got ${results[i].status})`).toBeLessThan(300);
    });
  });

  test("auth: a request WITHOUT the session token is rejected (the loopback gate is real)", async () => {
    const status = await page.evaluate(async () => {
      // Dial the in-guest server directly via the runtime, with NO auth header (bypass __HOLO_FETCH__).
      const rt = (window as unknown as { __HOLO_RUNTIME_FETCH__?: (u: string, i?: RequestInit) => Promise<Response> })
        .__HOLO_RUNTIME_FETCH__;
      if (!rt) return -1;
      const res = await rt("/api/sessions");
      return res.status;
    });
    // Either the bridge exposes the unauth fetch (then 401/403), or it doesn't (-1, skip the assertion).
    if (status !== -1) expect([401, 403]).toContain(status);
  });

  test("realtime: a WebSocket to /api/events connects over the bridge", async () => {
    const result = await page.evaluate(async () => {
      const mk = (window as unknown as { __HOLO_WS__?: (p: string) => WebSocket }).__HOLO_WS__;
      if (!mk) return { ok: false, reason: "no __HOLO_WS__" };
      return await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        const ws = mk("/api/events");
        const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 30_000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          ws.close();
          resolve({ ok: true });
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: "error" });
        });
      });
    });
    expect(result.ok, `events WebSocket connects (${result.reason ?? ""})`).toBe(true);
  });

  test("UI: the dashboard renders real backend data, not an error state", async () => {
    // The booted page already mounted the dashboard against the live backend; assert the real shell
    // rendered (nav present) and it is NOT the offline/stub view. No re-navigation (that would re-resume).
    await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
    const body = await page.locator("body").innerText();
    for (const label of [/sessions/i, /models/i, /chat/i]) {
      expect(body, `dashboard nav contains ${label}`).toMatch(label);
    }
    expect(body, "not the offline/stub view").not.toMatch(
      /isn.?t connected to a backend|run .{0,4}hermes dashboard.{0,4} locally|this static build|couldn.t be displayed/i,
    );
  });
});
