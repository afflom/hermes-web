import { defineConfig, devices } from "@playwright/test";

// Browser e2e/integration gate for the Hermes holospace Pages deployment. By default it serves the
// locally-assembled `_site` (build-app.sh + assemble-site.mjs) and drives a real Chromium against it —
// this is the CI gate. Set E2E_BASE_URL to a live deployment (e.g. https://afflom.github.io/hermes-web/,
// trailing slash) to run the SAME tests against the live site (no local server). Tests use relative URLs
// so both the root-served local site and the /<repo>/ project-site subpath resolve correctly.
const PORT = Number(process.env.E2E_PORT || 4178);
const LIVE = process.env.E2E_BASE_URL; // full base incl. trailing slash, or undefined for local
const baseURL = LIVE || `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 30_000 },
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
  // Only spin up the local static server when targeting the local _site.
  webServer: LIVE
    ? undefined
    : {
        command: "node serve.mjs",
        env: { PORT: String(PORT), SITE_ROOT: process.env.SITE_ROOT || "../../_site" },
        url: `http://localhost:${PORT}/index.html`,
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
      },
});
