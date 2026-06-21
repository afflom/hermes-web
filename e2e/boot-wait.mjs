import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const LOG = "/workspaces/hermes-web/vv/witness/boot-wait.log";
writeFileSync(LOG, "");
const say = (...a) => appendFileSync(LOG, a.join(" ") + "\n"); // file-flushed (survives SIGKILL)
const PORT = 4458;
const server = spawn("node", ["serve.mjs"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), BASE_PREFIX: "/hermes-web", SITE_ROOT: "../web/dist-pages" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || t.includes("holo")) say(`[c.${m.type()}]`, t); });
page.on("pageerror", (e) => say("[pageerror]", e.message));
const t0 = Date.now();
try {
  await page.goto(`http://localhost:${PORT}/hermes-web/`, { waitUntil: "load" });
  say("[nav] +" + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  for (let i = 0; i < 50; i++) {
    const s = await page.evaluate(() => ({
      ready: window.__HOLO_BACKEND_READY__ === true,
      phase: window.__HOLO_BOOT_PHASE__ || null,
      detail: window.__HOLO_BOOT_DETAIL__ || null,
      apiok: window.__HOLO_API_OK__,
      err: window.__HOLO_BOOT_ERROR__ || null,
    }));
    say(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(s));
    if (s.ready || s.err) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const fin = await page.evaluate(() => ({ ready: window.__HOLO_BACKEND_READY__ === true, apiok: window.__HOLO_API_OK__ }));
  say("FINAL", JSON.stringify(fin));
} catch (e) {
  say("HARNESS ERROR:", e.message);
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
