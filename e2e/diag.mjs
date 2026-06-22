// diag.mjs — fast standalone probe of the in-browser boot. Loads the built dashboard in a real Chromium,
// captures page console + errors, and dumps every __HOLO_*/__HERMES_* window beacon every 3s — including
// __HOLO_BOOT_ERROR__, which the spec didn't read. Far faster than the full spec for diagnosing why the
// worker is silent. Assumes a server is already up at E2E_BASE_URL (default the local serve.mjs URL).
import { chromium } from "@playwright/test";

const PORT = process.env.E2E_PORT || 4178;
const base = (process.env.E2E_BASE_URL || `http://localhost:${PORT}/hermes-web/`) + (process.env.DIAG_QUERY || "");
const SECONDS = Number(process.env.DIAG_SECONDS || 60);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`[c:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url()} — ${r.failure()?.errorText}`));

console.log(`[diag] goto ${base}`);
await page.goto(base, { waitUntil: "load" }).catch((e) => console.log(`[diag] goto failed: ${e.message}`));

let last = "";
for (let i = 0; i < SECONDS / 3; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const g = await page
    .evaluate(() => {
      const w = window;
      const out = {};
      for (const k of Object.keys(w)) {
        if (k.startsWith("__HOLO") || k.startsWith("__HERMES")) out[k] = String(w[k]).slice(0, 400);
      }
      out.crossOriginIsolated = w.crossOriginIsolated;
      out.hasSAB = typeof SharedArrayBuffer !== "undefined";
      return out;
    })
    .catch((e) => ({ evalError: e.message }));
  const s = JSON.stringify(g);
  if (s !== last) {
    console.log(`[diag t=${(i + 1) * 3}s] ${s}`);
    last = s;
  }
}
await browser.close();
console.log("[diag] done");
