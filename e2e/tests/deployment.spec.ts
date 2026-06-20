import { test, expect } from "@playwright/test";

// Browser e2e/integration for the Hermes holospace Pages deployment, against a real Chromium serving the
// assembled `_site`. These verify the deployed artifact actually works in a browser — not just that the
// files were produced.

// Relative URLs (resolved against baseURL) so the same tests run against the local root-served _site and
// the live /<repo>/ project-site subpath.
const HERMES_ENTRY = "usr/share/holospaces/hermes/index.html"; // physical app entry (no SW needed)
const HERMES_FLAT = "apps/hermes/index.html"; // flat path — resolves ONLY through the SW's FHS mapping
const CATALOG = "usr/share/holospaces/index.jsonld";

/** Wait until the dashboard's React root has mounted real content. */
async function rootMounted(scope: { waitForFunction: (fn: string) => Promise<unknown> }) {
  await scope.waitForFunction(
    "!!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0",
  );
}

/** Poll for the Service Worker to control the page, tolerating the boot redirect chain (which destroys
 *  the page execution context mid-poll). Returns true once `navigator.serviceWorker.controller` is set. */
async function waitForSWController(page: import("@playwright/test").Page): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const has = await page.evaluate(
        "!!(navigator.serviceWorker && navigator.serviceWorker.controller)",
      );
      if (has) return true;
    } catch {
      /* a boot navigation destroyed the context — retry */
    }
    await page.waitForTimeout(500);
  }
  return false;
}

test("A. the Hermes dashboard renders the static shell with no /api 404 (served statically)", async ({
  page,
}) => {
  // Any /api/* request that escapes to the static host (the bug the static-shell default fixes).
  const apiHits: string[] = [];
  page.on("request", (r) => {
    if (/\/api\//.test(new URL(r.url()).pathname)) apiHits.push(r.url());
  });

  await page.goto(HERMES_ENTRY, { waitUntil: "load" });
  await rootMounted(page);

  // The holospace build must select the STATIC transport — not `origin`, which would 404 /api on Pages.
  const mode = await page.evaluate(
    () => (window as unknown as { __HERMES_TRANSPORT_MODE__?: string }).__HERMES_TRANSPORT_MODE__,
  );
  expect(mode, "holospace build must boot the static shell, not origin").toBe("static");

  // The no-backend static shell renders (never a white-screen on the static host).
  await expect(page.getByTestId("holo-static-shell")).toBeVisible();
  await expect(page.getByText("Hermes", { exact: true })).toBeVisible();

  // The static shell makes no /api calls at all — nothing leaks to the origin.
  expect(apiHits, `static shell must not call /api; got: ${apiHits.join(", ")}`).toHaveLength(0);
});

test("B. the content-verify Service Worker serves the Hermes app by κ (flat path resolves only via SW)", async ({
  page,
}) => {
  await page.goto("./", { waitUntil: "load" });

  // The boot registers holo-fhs-sw.js and reloads/redirects to take control. Wait until it controls.
  expect(await waitForSWController(page), "Service Worker never took control of the page").toBe(true);

  // The flat URL has NO physical file (the app lives at usr/share/holospaces/hermes/index.html); it
  // resolves ONLY through the SW's FHS map + κ re-derivation. FETCH it through the SW (a top-level
  // navigation would be re-routed by the launcher, which mounts apps in iframes) and assert the SW
  // returned the Hermes app entry HTML — proof the content-verify SW serves the app by κ.
  const served = await page.evaluate(async (flat) => {
    const r = await fetch(flat);
    return { status: r.status, ctype: r.headers.get("content-type") || "", body: (await r.text()).slice(0, 4000) };
  }, HERMES_FLAT);
  expect(served.status, "SW did not serve the flat app-entry path").toBeLessThan(400);
  expect(served.ctype, "SW-served entry is not HTML").toContain("text/html");
  expect(served.body, "SW-served bytes are not the Hermes app entry").toMatch(/id="root"/);
});

test("D. the launcher mounts the Hermes app and it renders (κ-verified, no SAFETY STOP)", async ({
  page,
}) => {
  // The integration the others miss: the os-holo launcher must actually MOUNT Hermes. The authoritative
  // frame's SW fails CLOSED — if the Hermes-folded closure isn't re-anchored (reseal-site), every request
  // 409s and the launcher shows the "couldn't be verified / SAFETY STOP" refusal instead of the app.
  await page.goto("./", { waitUntil: "load" });
  expect(await waitForSWController(page), "Service Worker never took control of the page").toBe(true);

  // The launcher projection mounts an app by its identity into a sandboxed iframe.
  await page.goto("holospace.html?app=foundation.uor.hermes", { waitUntil: "load" });

  // It must NOT be the κ-verification refusal page.
  await expect(page.locator("body")).not.toContainText(/couldn.?t be verified|SAFETY STOP/i, {
    timeout: 15_000,
  });

  // The app mounts in an iframe and the Hermes static shell renders inside it (the real user outcome).
  const appFrame = page.frameLocator("iframe");
  await expect(appFrame.getByTestId("holo-static-shell")).toBeVisible({ timeout: 30_000 });
});

test("C. the apps catalog lists the Hermes app with its sealed root κ", async ({ page }) => {
  // Fetch the catalog directly (no boot-chain navigation race). It is served as apps/index.jsonld via the
  // SW and physically at usr/share/holospaces/index.jsonld — the assembled artifact is the same bytes.
  const r = await page.request.get(CATALOG);
  expect(r.ok(), "apps catalog not served").toBeTruthy();
  const catalog = (await r.json()) as Record<string, unknown>;
  const ds = (catalog["dcat:dataset"] || catalog["@graph"] || []) as Record<string, unknown>[];
  const hermes = ds.find((e) => e["schema:identifier"] === "foundation.uor.hermes");
  expect(hermes, "catalog does not list foundation.uor.hermes").toBeTruthy();
  expect(String(hermes!["@id"]), "Hermes catalog entry is not κ-addressed").toMatch(/^did:holo:sha256:/);
});
