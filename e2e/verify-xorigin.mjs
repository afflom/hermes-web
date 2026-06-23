// Standalone verification: the native agent's CROSS-ORIGIN LLM call rides the holospaces router extension's
// CORS-free fetch. Proves the real-provider egress path the same-origin e2e mock can't: the page's OWN fetch to
// the model origin is CORS-blocked, yet a full native chat turn completes — because the agent's outbound POST is
// routed through the extension (host_permissions *://*, service-worker fetch is CORS-exempt).
//
//   :4178  the built dashboard (/hermes-web), ?native=1                  ← the page origin
//   :4179  a CROSS-ORIGIN mock model (OpenAI SSE), NO CORS headers       ← unreachable by the page directly
//   ext    a localhost-allowed copy of web/public/holo/extension          ← the only way to reach :4179
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdtemp, cp, readFile as rf, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve, normalize } from "node:path";

const PAGE_PORT = 4178;
const MOCK_PORT = 4179;
const REPLY = "xorigin-extension-ok-9c2f";
const ROOT = resolve("../web/dist-pages");
const PREFIX = "/hermes-web";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json" };

// ── the page server (built dashboard) ──
const pageSrv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === PREFIX || p.startsWith(PREFIX + "/")) p = p.slice(PREFIX.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const rel = normalize(p).replace(/^([/\\])+/, "");
    let file = join(ROOT, rel);
    let body;
    try { body = await readFile(file); } catch { if (extname(p)) { res.writeHead(404); return res.end("404"); } body = await readFile(join(ROOT, "index.html")); file = "index.html"; }
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

// ── the CROSS-ORIGIN mock model — NO CORS headers, so a direct page fetch is blocked ──
const mockSrv = createServer((req, res) => {
  req.resume();
  if (req.method === "POST") {
    const sse = `data: {"id":"m","object":"chat.completion.chunk","model":"custom/mock","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(REPLY)}},"finish_reason":null}]}\n\n` +
      `data: {"id":"m","object":"chat.completion.chunk","model":"custom/mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` + `data: [DONE]\n\n`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "custom/mock", object: "model" }], models: [{ name: "custom/mock" }], version: "0.0.0", default_generation_settings: {} }));
  }
});

const log = (...a) => console.log("[xverify]", ...a);
let ctx;
try {
  await new Promise((r) => pageSrv.listen(PAGE_PORT, r));
  await new Promise((r) => mockSrv.listen(MOCK_PORT, r));
  log(`servers up: page :${PAGE_PORT}, cross-origin model :${MOCK_PORT}`);

  // localhost-allowed copy of the extension (the shipped manifest restricts to afflom.github.io).
  const extDir = await mkdtemp(join(tmpdir(), "holo-ext-"));
  await cp(resolve("../web/public/holo/extension"), extDir, { recursive: true });
  const man = JSON.parse(await rf(join(extDir, "manifest.json"), "utf8"));
  const localhost = ["http://localhost/*"]; // match patterns carry NO port — localhost matches any port
  man.externally_connectable = { matches: localhost };
  man.content_scripts[0].matches = localhost;
  await writeFile(join(extDir, "manifest.json"), JSON.stringify(man, null, 2));

  // Extensions only load in the NEW headless (old headless disables them). headless:false keeps Playwright from
  // forcing old --headless; --headless=new runs Chrome headless-new (no display needed) WITH extension support.
  ctx = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--headless=new`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-sandbox"],
  });
  // Wait for the extension's MV3 service worker (lazy — may register a beat after launch).
  for (let i = 0; i < 20 && ctx.serviceWorkers().length === 0; i++) await new Promise((r) => setTimeout(r, 300));
  log("service workers:", ctx.serviceWorkers().map((w) => w.url()));
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  page.on("console", (m) => { const t = m.text(); if (/\[holo|xverify|error|egress|extension/i.test(t)) log("pg:", t); });

  await page.goto(`http://localhost:${PAGE_PORT}${PREFIX}/?native=1`, { waitUntil: "load" });
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 120000 });
  log("native backend ready");

  // The extension must have announced its id to the page (content script → data-holospaces-egress).
  const extId = await page.waitForFunction("document.documentElement.getAttribute('data-holospaces-egress')", null, { timeout: 15000 }).then((h) => h.jsonValue());
  log("extension id on page:", extId);
  if (!extId) throw new Error("extension did not announce its id — content script / externally_connectable mismatch");

  // CONTROL: the page itself CANNOT reach the cross-origin model (CORS) — proving the path must use the extension.
  const direct = await page.evaluate(async (u) => { try { const r = await fetch(u, { method: "POST" }); return `status ${r.status}`; } catch (e) { return `BLOCKED ${String(e).slice(0, 60)}`; } }, `http://localhost:${MOCK_PORT}/v1/chat/completions`);
  log("direct page fetch to cross-origin model:", direct);

  // Point the agent at the CROSS-ORIGIN mock and drive a full chat turn — must complete via the extension.
  await page.evaluate(async (base) => {
    const yaml = `model:\n  default: "custom/mock"\n  provider: "custom"\n  base_url: "${base}"\n  api_key: "k"\n  api_mode: "chat_completions"\n`;
    await window.__HOLO_FETCH__("/api/config/raw", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml_text: yaml }) });
  }, `http://localhost:${MOCK_PORT}/v1`);

  const reply = await page.evaluate((REPLY) => new Promise((resolve, reject) => {
    const ws = window.__HOLO_WS__("/api/ws");
    let sid = "";
    const t = setTimeout(() => reject(new Error("no reply in 120s sid=" + sid)), 120000);
    ws.addEventListener("message", (ev) => {
      const d = typeof ev.data === "string" ? ev.data : "";
      if (d.includes(REPLY)) { clearTimeout(t); ws.close(); resolve("REPLY"); return; }
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.params?.type === "gateway.ready") ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: { title: "x" } }));
      else if (m.id === 1 && m.result) { sid = m.result.session_id ?? m.result.id ?? ""; ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sid, text: "go" } })); }
    });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("ws err " + String(e.data ?? ""))); });
  }), REPLY);

  const corsBlocked = direct.startsWith("BLOCKED");
  log("RESULT:", JSON.stringify({ corsBlockedForPage: corsBlocked, chatReplyViaExtension: reply === "REPLY" }));
  if (corsBlocked && reply === "REPLY") { log("PASS — cross-origin LLM works through the extension; the page itself is CORS-blocked"); process.exitCode = 0; }
  else { log("FAIL"); process.exitCode = 1; }
} catch (e) {
  log("ERROR", String(e).split("\n").slice(0, 4).join(" | "));
  process.exitCode = 1;
} finally {
  await ctx?.close();
  pageSrv.close(); mockSrv.close();
}
