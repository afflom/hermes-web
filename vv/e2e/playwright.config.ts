import { defineConfig, devices } from "@playwright/test";

// Browser e2e/integration gate for the Hermes holospace Pages deployment. Serves the assembled `_site`
// (build-app.sh + assemble-site.mjs must have produced it) and drives a real Chromium against it.
const PORT = Number(process.env.E2E_PORT || 4178);

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node serve.mjs",
    env: { PORT: String(PORT), SITE_ROOT: process.env.SITE_ROOT || "../../_site" },
    url: `http://localhost:${PORT}/index.html`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
});
