import { test, expect } from "@playwright/test";

// Browser e2e/integration for the hermes-web Pages deployment, against a real Chromium. Verifies the
// deployed artifact is JUST the Hermes dashboard — it renders, and it is NOT the Hologram-OS frame.

test("the hermes-web dashboard loads and renders (no white-screen)", async ({ page }) => {
  const apiHits: string[] = [];
  page.on("request", (r) => {
    if (/\/api\//.test(new URL(r.url()).pathname)) apiHits.push(r.url());
  });

  await page.goto("./", { waitUntil: "load" });

  // The React root mounts and the static (no-backend) shell renders — never a white-screen on Pages.
  await page.waitForFunction(
    "!!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0",
  );
  await expect(page.getByTestId("holo-static-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hermes" })).toBeVisible();

  // No backend on a static host → the static build must not call /api at all.
  expect(apiHits, `static build must not call /api; got: ${apiHits.join(", ")}`).toHaveLength(0);
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
  // None of the Hologram-OS boot/frame markers may be present.
  expect(bodyText).not.toMatch(/Hologram OS|SAFETY STOP|Booting Hologram/i);
  // The dashboard build must not register a content-verify Service Worker (a frame behavior).
  expect(swRegistered, "the dashboard build must not register a Service Worker").toBe(false);
});
