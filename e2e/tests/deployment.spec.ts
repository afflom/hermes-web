import { test, expect } from "@playwright/test";

// Browser e2e/integration for the hermes-web Pages deployment, against a real Chromium. Verifies the
// deployed artifact is the REAL Hermes dashboard (its actual UI, with empty states on a static host) —
// not a stub/placeholder, and not the Hologram-OS frame.

const STUB = /isn.?t connected to a backend|run .{0,4}hermes dashboard.{0,4} locally|this static build/i;

test("the dashboard renders its real UI (chrome + sidebar nav), not a stub", async ({ page }) => {
  await page.goto("./", { waitUntil: "load" });
  // React mounts and renders real content (redirects to /sessions).
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");

  const body = await page.locator("body").innerText();
  // The actual dashboard chrome: the sidebar navigation sections.
  for (const label of [/sessions/i, /models/i, /chat/i, /logs/i, /config/i]) {
    expect(body, `dashboard nav should contain ${label}`).toMatch(label);
  }
  // It must NOT be the forbidden "run it locally" placeholder.
  expect(body, "deploy must be the real dashboard, not a stub").not.toMatch(STUB);
  // Landed on the real sessions view under the project subpath.
  expect(new URL(page.url()).pathname).toMatch(/\/sessions$/);
});

test("client-side routing works under the project subpath", async ({ page }) => {
  // Direct-load a deep route (SPA fallback + the router basename must keep the /hermes-web prefix).
  await page.goto("models", { waitUntil: "load" });
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
  expect(new URL(page.url()).pathname).toMatch(/\/models$/);
  await expect(page.locator("body")).not.toContainText(STUB);
});

test("the holospaces wasm runtime loads in the browser and re-derives κ (substrate liveness)", async ({ page }) => {
  // The data plane runs the real backend in this content-addressed RISC-V runtime. Before any warm κ
  // is involved, prove the vendored wasm itself initializes on the deployed artifact and computes the
  // substrate content address (blake3, Law L2) — deterministic for equal bytes, distinct otherwise.
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

test("the in-browser holospaces backend resumes and authenticates the dashboard", async ({ page }) => {
  // The Pages build runs the real Hermes backend in an in-browser holospaces RISC-V guest and resumes
  // it from a banked warm κ. This verifies the whole chain end to end: the warm-κ manifest is published,
  // the guest resumes, the loopback transport installs, and the in-guest web_server.py authenticates us
  // (its injected session token reaches `window.__HERMES_SESSION_TOKEN__`). Hard-required when
  // E2E_EXPECT_HOLOGRAM=1 (the holospaces deploy gate); otherwise skipped until the κ is shipped.
  const expectHologram = process.env.E2E_EXPECT_HOLOGRAM === "1";
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

  // `__HOLO_BACKEND_READY__` is set by the bootstrap ONLY after the whole chain succeeds over the
  // in-process loopback bridge: resume the warm κ → guest re-accepts → install transport → adopt the
  // in-guest session token → a live protected /api/status answers. First load fetches the warm machine,
  // so allow generous time; cached warm-starts are seconds.
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 180_000 });
  const token = await page.evaluate(() => (window as unknown as { __HERMES_SESSION_TOKEN__?: string }).__HERMES_SESSION_TOKEN__);
  expect(typeof token === "string" && token.length > 0, "in-guest session token adopted").toBe(true);
});

test("the deployment is hermes-web, NOT the Hologram-OS frame", async ({ page }) => {
  await page.goto("./", { waitUntil: "load" });
  await page.waitForTimeout(800); // allow any (unexpected) service worker to register

  const swRegistered = await page
    .evaluate(async () => {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      return !!(regs && regs.length);
    })
    .catch(() => false);

  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/Hologram OS|SAFETY STOP|Booting Hologram/i);
  expect(swRegistered, "the dashboard build must not register a Service Worker").toBe(false);
});
