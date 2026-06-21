import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 4455;
const server = spawn("node", ["serve.mjs"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), BASE_PREFIX: "/hermes-web", SITE_ROOT: "../web/dist-pages" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const log = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push("PAGEERROR: " + e.message));
page.on("requestfailed", (r) => log.push(`REQFAIL ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(`http://localhost:${PORT}/hermes-web/`, { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 6000));
const info = await page.evaluate(() => ({
  root: document.querySelector("#root")?.childElementCount ?? -1,
  body: document.body.innerText.slice(0, 200),
  phase: window.__HOLO_BOOT_PHASE__ ?? "(none)",
  scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
}));
console.log("ROOT_CHILDREN:", info.root);
console.log("PHASE:", info.phase);
console.log("BODY:", JSON.stringify(info.body));
console.log("SCRIPTS:", info.scripts.join(", "));
console.log("EVENTS:\n" + (log.join("\n") || "(none)"));
await browser.close(); server.kill();
