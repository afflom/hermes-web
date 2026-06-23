import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Build the native-exec backend bundle (the real Hermes Python + dep manifest from pyproject + the OS-surface
// adapter) into public/native/ so the production build ships it for the native worker to fetch. DRY: one build
// step, derived from the repo source — never a hand-maintained copy.
function hermesNativeBundle(): Plugin {
  return {
    name: "hermes:native-bundle",
    apply: "build",
    buildStart() {
      execFileSync("node", [path.resolve(__dirname, "scripts/bundle-hermes-native.mjs")], { stdio: "inherit" });
    },
  };
}

const BACKEND = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";

// The holospaces wasm runtime + its JS glue ship in public/holo/ at STABLE URLs (not Vite-hashed). When they
// change across deploys, a returning browser serves the stale cached copy against the new worker → boot
// crash. Hash their contents at build time so the worker can cache-bust the load (?v=<hash>): immutable per
// build, but any change yields fresh URLs that bypass the browser + Pages/Fastly cache.
function holoAssetVer(): string {
  try {
    const h = createHash("sha256");
    for (const f of ["public/holo/holospaces_web_bg.wasm", "public/holo/holospaces_web.js"]) {
      const p = path.resolve(__dirname, f);
      if (existsSync(p)) h.update(readFileSync(p));
    }
    return h.digest("hex").slice(0, 12);
  } catch {
    return "0";
  }
}

/**
 * In production the Python `hermes dashboard` server injects a one-shot
 * session token into `index.html` (see `hermes_cli/web_server.py`). The
 * Vite dev server serves its own `index.html`, so unless we forward that
 * token, every protected `/api/*` call 401s.
 *
 * This plugin fetches the running dashboard's `index.html` on each dev page
 * load, scrapes the `window.__HERMES_SESSION_TOKEN__` assignment, and
 * re-injects it into the dev HTML. No-op in production builds.
 */
function hermesDevToken(): Plugin {
  const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
  const EMBEDDED_RE =
    /window\.__HERMES_DASHBOARD_EMBEDDED_CHAT__\s*=\s*(true|false)/;

  return {
    name: "hermes:dev-session-token",
    apply: "serve",
    async transformIndexHtml() {
      try {
        const res = await fetch(BACKEND, { headers: { accept: "text/html" } });
        const html = await res.text();
        const match = html.match(TOKEN_RE);
        if (!match) {
          console.warn(
            `[hermes] Could not find session token in ${BACKEND} — ` +
              `is \`hermes dashboard\` running? /api calls will 401.`,
          );
          return;
        }
        const embeddedMatch = html.match(EMBEDDED_RE);
        const embeddedJs = embeddedMatch ? embeddedMatch[1] : "true";
        return [
          {
            tag: "script",
            injectTo: "head",
            children:
              `window.__HERMES_SESSION_TOKEN__="${match[1]}";` +
              `window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=${embeddedJs};`,
          },
        ];
      } catch (err) {
        console.warn(
          `[hermes] Dashboard at ${BACKEND} unreachable — ` +
            `start it with \`hermes dashboard\` or set HERMES_DASHBOARD_URL. ` +
            `(${(err as Error).message})`,
        );
      }
    },
  };
}

export default defineConfig({
  // Base path for emitted asset URLs.
  //   "/"  (default) — the server-hosted dashboard (`hermes_cli/web_server.py`)
  //                    serves index.html for deep client-routed paths under an
  //                    optional X-Forwarded-Prefix, so assets must be absolute.
  //   "./" (HERMES_HOLO_BASE=./) — the holospace app object is mounted at a
  //                    fixed `./apps/hermes/index.html` inside a sandboxed
  //                    iframe (os-holo `holospace.html`), so relative asset refs
  //                    resolve into the sealed κ-closure (Law L5). Set only by
  //                    the holospace build (`tools/holo/build-app.sh`), never the
  //                    server build, which would 404 on deep client routes.
  base: process.env.HERMES_HOLO_BASE ?? "/",
  define: {
    // True only in the holospace app-object build (HERMES_HOLO_BASE set): mounted in the os-holo frame
    // with NO co-located /api backend, so the transport bootstrap defaults to the static navigable shell
    // (empty states, inert sockets) instead of `origin` when the launcher injects no guest bridge. The
    // server build leaves this false → `origin` → the real Python `hermes dashboard` /api backend.
    __HERMES_HOLO_BUILD__: JSON.stringify(process.env.HERMES_HOLO_BASE != null),
    // Content hash of the holospaces wasm + glue, for cache-busting their stable-URL load in the worker.
    __HOLO_ASSET_VER__: JSON.stringify(holoAssetVer()),
  },
  plugins: [react(), tailwindcss(), hermesDevToken(), hermesNativeBundle()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // When @nous-research/ui is symlinked via `file:../../design-language`,
    // Node's module resolution would pick up shared deps from
    // design-language/node_modules/*, giving us two copies + breaking
    // hooks (useRef-of-null), webgl contexts, etc. Force everything that
    // exists in BOTH places to use the dashboard's copy.
    //
    // Don't list packages here that only exist in the DS (nanostores,
    // @nanostores/react) — Vite dedupe errors out when it can't find
    // them at the project root.
    dedupe: [
      "react",
      "react-dom",
      "@react-three/fiber",
      "@observablehq/plot",
      "three",
      "leva",
      "gsap",
    ],
  },
  build: {
    outDir: "../hermes_cli/web_dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: BACKEND,
        ws: true,
      },
      // Same host as `hermes dashboard` must serve these; Vite has no
      // dashboard-plugins/* files, so without this, plugin scripts 404
      // or receive index.html in dev.
      "/dashboard-plugins": BACKEND,
    },
  },
});
