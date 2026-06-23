// serve.mjs — minimal static server for the Hermes Pages build, for the Playwright e2e gate.
// Serves the Vite `dist` with correct MIME types. The production build uses a /<repo>/ base, so an
// optional BASE_PREFIX (default /hermes-web) is stripped from request paths and mirrored as the served
// subpath — so the local e2e exercises the exact same base as the live GitHub Pages project site.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, normalize } from "node:path";

const ROOT = resolve(process.env.SITE_ROOT || "../web/dist-pages");
const PORT = Number(process.env.PORT || 4178);
const PREFIX = (process.env.BASE_PREFIX ?? "/hermes-web").replace(/\/+$/, ""); // "" disables the prefix

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
    if (PREFIX && (urlPath === PREFIX || urlPath.startsWith(PREFIX + "/"))) urlPath = urlPath.slice(PREFIX.length) || "/";

    // Same-origin mock model for the native-agent e2e: the native LLM call (httpx → egress → run_sync → fetch)
    // round-trips here without a real provider/key or cross-origin CORS. POST chat/completions streams an SSE
    // reply; the agent's provider-detection GETs (/v1/models, /api/tags, /v1/props, /version, …) get a permissive
    // JSON so detection succeeds instead of retry-storming and eating the turn budget.
    if (urlPath.startsWith("/mock-llm/")) {
      req.resume(); // drain any request body we don't need
      if (req.method === "POST") {
        const reply = "native-browser-turn-ok-3b9f";
        const sse =
          `data: {"id":"mock","object":"chat.completion.chunk","model":"custom/mock","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(reply)}},"finish_reason":null}]}\n\n` +
          `data: {"id":"mock","object":"chat.completion.chunk","model":"custom/mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: [DONE]\n\n`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse);
      } else {
        const discovery = {
          object: "list",
          data: [{ id: "custom/mock", object: "model", owned_by: "mock" }],
          models: [{ name: "custom/mock", model: "custom/mock" }], // Ollama /api/tags shape
          version: "0.0.0",
          default_generation_settings: {}, // llama.cpp /v1/props shape
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(discovery));
      }
      return;
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const rel = normalize(urlPath).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, rel);
    let s;
    try {
      s = await stat(file);
    } catch {
      // SPA fallback: only EXTENSIONLESS routes (client paths like /models) serve index.html. Missing
      // assets (.json/.wasm/.js/…) must 404 — matching GitHub Pages — so probes like the warm-κ
      // manifest check see a real miss instead of HTML masquerading as JSON.
      if (extname(urlPath)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404 " + urlPath); return; }
      file = join(ROOT, "index.html");
      try { s = await stat(file); } catch { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404 " + urlPath); return; }
    }
    if (s.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e));
  }
});
server.listen(PORT, () => console.log(`[e2e] static server http://localhost:${PORT}${PREFIX}/  root=${ROOT}`));
