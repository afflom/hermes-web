import { test, expect } from "@playwright/test";

// Browser e2e/integration for the hermes-web Pages deployment, against a real Chromium. The data plane
// is the real Hermes backend running in an in-browser holospaces RISC-V guest — there is no fake/static
// fallback. So the suite splits into:
//   • always-on:   the holospaces wasm runtime is live on the artifact; the page is the hermes-web
//                  shell (not a stub, not the Hologram-OS frame, no Service Worker).
//   • backend-gated: once a warm κ is published, the in-browser backend RESUMES, authenticates, and the
//                  real dashboard renders. Hard-required under E2E_EXPECT_HOLOGRAM=1 (the deploy gate);
//                  skipped until the κ is shipped.

const STUB = /isn.?t connected to a backend|run .{0,4}hermes dashboard.{0,4} locally|this static build/i;

test("the holospaces wasm runtime loads in the browser and re-derives κ (substrate liveness)", async ({ page }) => {
  // The data plane runs the real backend in this content-addressed RISC-V runtime. Prove the vendored
  // wasm itself initializes on the deployed artifact and computes the substrate content address
  // (blake3, Law L2) — deterministic for equal bytes, distinct otherwise.
  await page.goto("./", { waitUntil: "load" });
  const res = await page.evaluate(async () => {
    const url = new URL("holo/holospaces_web.js", location.href).href;
    const mod = await import(/* @vite-ignore */ url);
    await mod.default();
    return {
      k1: mod.kappa(new Uint8Array([1, 2, 3])),
      k2: mod.kappa(new Uint8Array([1, 2, 3])),
      k3: mod.kappa(new Uint8Array([1, 2, 4])),
    };
  });
  expect(res.k1, "κ is a substrate blake3 label").toMatch(/^blake3:[0-9a-f]+$/);
  expect(res.k1, "equal bytes re-derive to the same κ (deterministic content address)").toBe(res.k2);
  expect(res.k1, "different bytes yield a different κ").not.toBe(res.k3);
});

test("the deployment is the hermes-web shell, NOT the Hologram-OS frame", async ({ page }) => {
  await page.goto("./", { waitUntil: "load" });
  // React mounts (the boot gate or the app — either way #root has content, never a white screen).
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
  await page.waitForTimeout(800); // allow any (unexpected) service worker to register

  const swRegistered = await page
    .evaluate(async () => {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      return !!(regs && regs.length);
    })
    .catch(() => false);

  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "the hermes-web shell is present").toMatch(/hermes/i);
  expect(bodyText, "must not be the Hologram-OS frame").not.toMatch(/Hologram OS|SAFETY STOP|Booting Hologram/i);
  expect(swRegistered, "the dashboard build must not register a Service Worker").toBe(false);
});

test("the in-browser holospaces backend resumes, authenticates, and renders the real dashboard", async ({ page }) => {
  // The whole chain end to end: the warm-κ manifest is published, the guest resumes (disk paged from
  // the OPFS κ-store), the loopback transport installs, the in-guest web_server.py authenticates us
  // (its injected token reaches window.__HERMES_SESSION_TOKEN__), and the real dashboard renders against
  // it. Hard-required when E2E_EXPECT_HOLOGRAM=1; otherwise skipped until the κ is shipped.
  const expectHologram = process.env.E2E_EXPECT_HOLOGRAM === "1";
  test.setTimeout(300_000); // first load fetches + resumes the 1.44 GB warm machine (~75 s)
  // Surface the in-browser boot to the CI log — the worker relays [holo]/[hermes] boot timings + errors;
  // if READY never arrives we can see exactly where it stalled (resume vs auth) instead of a blind timeout.
  page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));
  await page.goto("./", { waitUntil: "load" });

  const hasManifest = await page.evaluate(async () => {
    try {
      const r = await fetch("holo/warm/manifest.json", { cache: "no-cache" });
      if (!r.ok) return false;
      const m = await r.json(); // a real manifest, not an SPA-fallback HTML page
      return typeof m?.kappa === "string" && Array.isArray(m?.chunks) && m.chunks.length > 0;
    } catch {
      return false;
    }
  });
  if (!hasManifest) {
    test.skip(!expectHologram, "no warm-κ manifest published for this build yet");
    expect(hasManifest, "E2E_EXPECT_HOLOGRAM=1 but no warm-κ manifest is published").toBe(true);
  }

  // __HOLO_BACKEND_READY__ is set ONLY after resume → guest re-accepts → transport installed → in-guest
  // token adopted → a live protected /api/status answers, all over the loopback bridge. First load
  // fetches the warm machine, so allow generous time; cached warm-starts are seconds.
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 180_000 });
  const token = await page.evaluate(() => (window as unknown as { __HERMES_SESSION_TOKEN__?: string }).__HERMES_SESSION_TOKEN__);
  expect(typeof token === "string" && token.length > 0, "in-guest session token adopted").toBe(true);

  // The real dashboard is now mounted against the in-browser backend: chrome + sidebar nav, not a stub.
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
  const body = await page.locator("body").innerText();
  for (const label of [/sessions/i, /models/i, /chat/i, /logs/i, /config/i]) {
    expect(body, `dashboard nav should contain ${label}`).toMatch(label);
  }
  expect(body, "must be the real dashboard, not a stub").not.toMatch(STUB);

  // Client-side routing works under the project subpath (SPA fallback + router basename keep /hermes-web).
  await page.goto("models", { waitUntil: "load" });
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 180_000 });
  expect(new URL(page.url()).pathname).toMatch(/\/models$/);
});
