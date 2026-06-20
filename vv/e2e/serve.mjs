// serve.mjs — minimal static server for the assembled `_site`, for the Playwright e2e gate.
// Serves the physical files as-is with correct MIME types (ES modules require text/javascript) and
// grants the content-verify Service Worker root scope (Service-Worker-Allowed: /). The SW performs the
// flat→FHS path mapping and κ verification client-side, so this server only mirrors a static host.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, normalize } from "node:path";

const ROOT = resolve(process.env.SITE_ROOT || "../../_site");
const PORT = Number(process.env.PORT || 4178);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonld": "application/ld+json; charset=utf-8",
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
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const rel = normalize(urlPath).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, rel);
    let s;
    try {
      s = await stat(file);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 " + urlPath);
      return;
    }
    if (s.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    // The content-verify SW must be allowed to claim the root scope from a nested path.
    if (file.endsWith("holo-fhs-sw.js")) headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e));
  }
});
server.listen(PORT, () => console.log(`[e2e] static server http://localhost:${PORT}  root=${ROOT}`));
