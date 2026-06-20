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
