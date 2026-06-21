// Debug harness: load the built dashboard, resume the in-browser backend, and stream console + boot
// progress so we can see whether the 1.44 GB resume is slow or failing (and where).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 4321;
const server = spawn("node", ["serve.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), BASE_PREFIX: "/hermes-web", SITE_ROOT: "../web/dist-pages" },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/hermes-web/`, { waitUntil: "load" });
console.log(`[nav] loaded at +${((Date.now() - t0) / 1000).toFixed(1)}s`);

for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => ({
    ready: window.__HOLO_BACKEND_READY__ === true,
    phase: window.__HOLO_BOOT_PHASE__ || null,
    detail: window.__HOLO_BOOT_DETAIL__ || null,
    at: window.__HOLO_BOOT_ELAPSED__ || null,
    token: typeof window.__HERMES_SESSION_TOKEN__ === "string",
    err: window.__HOLO_BOOT_ERROR__ || null,
  }));
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(s));
  if (s.ready || s.err) break;
  await new Promise((r) => setTimeout(r, 4000));
}

const finalReady = await page.evaluate(() => window.__HOLO_BACKEND_READY__ === true);
console.log("FINAL ready =", finalReady);
await browser.close();
server.kill();
process.exit(finalReady ? 0 : 1);
