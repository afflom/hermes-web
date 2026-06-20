import { chromium } from "@playwright/test";
const url = process.argv[2] || "http://localhost:4178/usr/share/holospaces/hermes/index.html";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ""}`));
page.on("requestfailed", (r) => logs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`); });
try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
} catch (e) {
  logs.push(`[goto-error] ${e.message}`);
}
await page.waitForTimeout(3500);
const info = await page.evaluate(() => ({
  rootCount: document.querySelector("#root")?.childElementCount ?? -1,
  mode: window.__HERMES_TRANSPORT_MODE__ ?? "(unset)",
  rootHtml: (document.querySelector("#root")?.innerHTML || "").slice(0, 300),
  title: document.title,
  swController: !!navigator.serviceWorker?.controller,
}));
console.log("URL:", url);
console.log("rootCount:", info.rootCount, "| mode:", info.mode, "| title:", info.title, "| swCtrl:", info.swController);
console.log("rootHtml[0:300]:", info.rootHtml);
console.log("--- logs ---\n" + logs.join("\n"));
await browser.close();
