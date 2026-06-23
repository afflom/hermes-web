import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Capture the warm-κ dashboard read seed FROM THE BROWSER — i.e. over the EXACT production serving path
// (the worker's single-lane guest fetch against the resumed κ, via window.__HOLO_FETCH__). This replaces the
// native cc_capture_responses witness, which cannot re-serve the unsettled-banked unified κ in a tight
// instruction loop (the browser's real-time-paced pump does; native burns its budget and never gets "/").
//
// SAFE_WARM_PATHS is the SINGLE SOURCE OF TRUTH (in the Rust witness) for the local-read GET set the seed
// must cover; we parse it here so the capture and the bank's warm list never drift.
//
// Run manually after a re-bank + re-chunk (and after emptying the shipped seed so every read hits the guest
// FRESH rather than returning a stale prior seed):
//   printf '{}' > web/public/holo/warm/warm-responses.json
//   BUILD=1 E2E_EXPECT_HOLOGRAM=1 E2E_TIMEOUT=900 e2e/run.sh -g "capture the warm"
//   node tools/holo/chunk-warm-kappa.mjs vv/witness/hermes-warm.kappa web/public/holo/warm   # ships the new seed
const WITNESS = resolve(HERE, "../../tools/holo/witness/cc_hermes_guest.rs");
const OUT = resolve(HERE, "../../vv/witness/warm-responses.json");

/** Parse the `/api/...` entries out of the Rust `SAFE_WARM_PATHS` const — one source of truth. */
function safeWarmPaths(): string[] {
  const src = readFileSync(WITNESS, "utf8");
  const block = src.match(/const SAFE_WARM_PATHS[^=]*=\s*&\[([\s\S]*?)\];/);
  if (!block) throw new Error("SAFE_WARM_PATHS not found in the witness");
  const paths = [...block[1].matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
  // De-dupe while preserving order.
  return [...new Set(paths)];
}

test("capture the warm-κ dashboard read seed from the live in-browser backend", async ({ page }) => {
  test.setTimeout(1_500_000); // the heavy first-call reads (e.g. /api/status ~100 s) serialize on the single lane
  page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));

  await page.goto("./", { waitUntil: "load" });
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 400_000 });
  // The RAW capture hook (bypasses the worker's seed/status/egress handlers so we see the guest's true
  // response, e.g. /api/status → 200 rather than its uncached short-circuit 503).
  await page.waitForFunction("typeof window.__HOLO_CAPTURE__ === 'function'", null, { timeout: 5_000 });

  // "/" (the dashboard HTML, carrying the frozen session token) is captured FIRST so the worker can adopt the
  // session token from the seed and skip the costly first-dial establishment on boot (the token is frozen in
  // the κ, so the bank-time value is the one the resumed guest validates). The /api local reads follow.
  const paths = ["/", ...safeWarmPaths()];
  console.log(`[capture] capturing ${paths.length} paths (incl. "/" for seed-served auth) from the live backend`);

  const data = await page.evaluate(async (paths: string[]) => {
    const hex = (buf: ArrayBuffer) =>
      Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    const f = (window as unknown as { __HOLO_CAPTURE__: (p: string) => Promise<Response> }).__HOLO_CAPTURE__;
    const out: Record<string, { status: number; ct: string; body: string }> = {};
    for (const p of paths) {
      const res = await f(p);
      const buf = await res.arrayBuffer();
      out[p] = { status: res.status, ct: res.headers.get("content-type") || "application/json", body: hex(buf) };
      // eslint-disable-next-line no-console
      console.log(`[capture] ${p} → ${res.status} ${buf.byteLength}B`);
    }
    return out;
  }, paths);

  // The seed records the guest's TRUE responses — some are legitimately non-2xx (e.g. /api/auth/me → 401,
  // which the dashboard tolerates). We don't force 2xx; instead we assert the critical invariants:
  //   • /api/status MUST be a clean 200 (the sidebar's heartbeat; a 503 here = we captured the short-circuit)
  //   • nothing is the egress 503 ("router extension required") — that would mean a network path leaked in
  const status = data["/api/status"];
  expect(status?.status, "/api/status must capture a real 200 (not the uncached short-circuit)").toBe(200);
  // "/" must be a 200 carrying the frozen session token, so the worker can adopt auth from the seed and skip
  // the costly first-dial establishment (the dominant boot term). Without this the seed-served-auth fast path
  // can't engage and the boot falls back to the slow first dial.
  const root = data["/"];
  expect(root?.status, '"/" (dashboard HTML) must capture a 200 for seed-served auth').toBe(200);
  expect(Buffer.from(root.body, "hex").toString("utf8"), '"/" must carry the frozen session token').toMatch(
    /__HERMES_SESSION_TOKEN__\s*=\s*"[^"]+"/,
  );
  const leaked = Object.entries(data).filter(([, r]) => r.status === 503);
  expect(leaked.map(([p]) => p), "no captured path may be the egress 503 (network paths must be gated, not seeded)").toEqual([]);
  expect(Object.keys(data).length, "captured most paths").toBeGreaterThanOrEqual(paths.length - 1);

  writeFileSync(OUT, `${JSON.stringify(data, null, 0)}\n`);
  console.log(`[capture] wrote ${Object.keys(data).length} responses → ${OUT}`);
});
