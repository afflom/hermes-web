import { defineConfig, devices } from "@playwright/test";

// Browser e2e/integration gate for the hermes-web Pages deployment. By default it serves the local Vite
// build (web/dist-pages) under the /hermes-web base (matching the live project site) and drives a real
// Chromium against it — the CI gate. Set E2E_BASE_URL to a live deployment (e.g.
// https://afflom.github.io/hermes-web/, trailing slash) to run the SAME tests against the live site.
const PORT = Number(process.env.E2E_PORT || 4178);
const PREFIX = "/hermes-web";
const LIVE = process.env.E2E_BASE_URL; // full base incl. trailing slash, or undefined for local
const baseURL = LIVE || `http://localhost:${PORT}${PREFIX}/`;

export default defineConfig({
  testDir: "./tests",
  // Resuming the 1.44 GB warm machine in-browser is multi-minute; this is the test AND hook (beforeAll)
  // budget — describe.configure({timeout}) does NOT raise the hook timeout, only this global value does.
  // The fast substrate/shell tests still finish in seconds; this only bounds the worst case.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI || LIVE ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: LIVE
    ? undefined
    : {
        command: "node serve.mjs",
        env: {
          PORT: String(PORT),
          BASE_PREFIX: PREFIX,
          SITE_ROOT: process.env.SITE_ROOT || "../web/dist-pages",
        },
        url: `http://localhost:${PORT}${PREFIX}/`,
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
      },
});
