import { test, expect } from "@playwright/test";
import { appendFileSync } from "node:fs";

// Mirror the browser console to a file when E2E_CONSOLE_LOG is set. Playwright's `list` reporter buffers
// (and locally often drops) console.log from page handlers, so the in-guest boot/auth diagnostic never
// reaches stdout. Appending straight to a file makes the capture reliable regardless of the reporter —
// the harness (e2e/run.sh) points this at the run's log dir and prints it in the summary.
const CONSOLE_LOG = process.env.E2E_CONSOLE_LOG;
function recordConsole(line: string): void {
  console.log(line); // still emit to stdout for CI, where it IS streamed
  if (CONSOLE_LOG) {
    try {
      appendFileSync(CONSOLE_LOG, line + "\n");
    } catch {
      /* best-effort: never fail a test on logging */
    }
  }
}

// Browser e2e/integration for the hermes-web Pages deployment, against a real Chromium. The data plane
// is the real Hermes backend running in an in-browser holospaces RISC-V guest — there is no fake/static
// fallback. So the suite splits into:
//   • always-on:   the holospaces wasm runtime is live on the artifact; the page is the hermes-web
//                  shell (not a stub, not the Hologram-OS frame, no Service Worker).
//   • backend-gated: once a warm κ is published, the in-browser backend RESUMES, authenticates, and the
//                  real dashboard renders. Hard-required under E2E_EXPECT_HOLOGRAM=1 (the deploy gate);
//                  skipped until the κ is shipped.

const STUB = /isn.?t connected to a backend|run .{0,4}hermes dashboard.{0,4} locally|this static build/i;

test("the holospaces wasm runtime loads in the browser and re-derives κ (substrate liveness)", async ({ page }) => {
  // The data plane runs the real backend in this content-addressed RISC-V runtime. Prove the vendored
  // wasm itself initializes on the deployed artifact and computes the substrate content address
  // (blake3, Law L2) — deterministic for equal bytes, distinct otherwise.
  await page.goto("./", { waitUntil: "load" });
  const res = await page.evaluate(async () => {
    const url = new URL("holo/holospaces_web.js", location.href).href;
    const mod = await import(/* @vite-ignore */ url);
    await mod.default();
    return {
      k1: mod.kappa(new Uint8Array([1, 2, 3])),
      k2: mod.kappa(new Uint8Array([1, 2, 3])),
      k3: mod.kappa(new Uint8Array([1, 2, 4])),
    };
  });
  expect(res.k1, "κ is a substrate blake3 label").toMatch(/^blake3:[0-9a-f]+$/);
  expect(res.k1, "equal bytes re-derive to the same κ (deterministic content address)").toBe(res.k2);
  expect(res.k1, "different bytes yield a different κ").not.toBe(res.k3);
});

test("the deployment is the hermes-web shell, NOT the Hologram-OS frame", async ({ page }) => {
  await page.goto("./", { waitUntil: "load" });
  // React mounts (the boot gate or the app — either way #root has content, never a white screen).
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
  await page.waitForTimeout(800); // allow any (unexpected) service worker to register

  const swRegistered = await page
    .evaluate(async () => {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      return !!(regs && regs.length);
    })
    .catch(() => false);

  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "the hermes-web shell is present").toMatch(/hermes/i);
  expect(bodyText, "must not be the Hologram-OS frame").not.toMatch(/Hologram OS|SAFETY STOP|Booting Hologram/i);
  expect(swRegistered, "the dashboard build must not register a Service Worker").toBe(false);
});

test("the in-browser holospaces backend resumes, authenticates, and renders the real dashboard", async ({ page }) => {
  // The whole chain end to end: the warm-κ manifest is published, the guest resumes (disk paged from
  // the OPFS κ-store), the loopback transport installs, the in-guest web_server.py authenticates us
  // (its injected token reaches window.__HERMES_SESSION_TOKEN__), and the real dashboard renders against
  // it. Hard-required when E2E_EXPECT_HOLOGRAM=1; otherwise skipped until the κ is shipped.
  const expectHologram = process.env.E2E_EXPECT_HOLOGRAM === "1";
  test.setTimeout(600_000); // TWO full boots (initial + the /models deep-link reload), each ~170 s with the
  // low-memory streaming load (incremental JS blake3 verify + on-demand inflate trade boot time for a ~2.3 GB
  // peak instead of ~3.3 GB).
  // Surface the in-browser boot to the CI log — the worker relays [holo]/[hermes] boot timings + errors;
  // if READY never arrives we can see exactly where it stalled (resume vs auth) instead of a blind timeout.
  // Collect every guest GET the worker actually dialed. The worker logs "→ guest GET <path>" ONLY on a warm-
  // seed MISS (a hit is served from RAM, never dialed) — so this set IS the dashboard's slow-path reads. A
  // local read that misses the seed round-trips the single guest lane (~10 s) and is the "dashboard takes an
  // hour" regression; we assert below that the only misses are the legitimately un-seedable ones.
  const guestGets: string[] = [];
  let seedServedAuth = false; // did the boot adopt the session token from the warm seed (establishment deferred)?
  page.on("console", (m) => {
    const t = m.text();
    recordConsole(`[browser:${m.type()}] ${t}`);
    const g = t.match(/→ guest GET (\S+)/);
    if (g) guestGets.push(g[1]);
    if (/seed-served auth/.test(t)) seedServedAuth = true;
  });
  page.on("pageerror", (e) => recordConsole(`[browser:pageerror] ${e.message}`));
  await page.goto("./", { waitUntil: "load" });

  const hasManifest = await page.evaluate(async () => {
    try {
      const r = await fetch("holo/warm/manifest.json", { cache: "no-cache" });
      if (!r.ok) return false;
      const m = await r.json(); // a real manifest, not an SPA-fallback HTML page
      return typeof m?.kappa === "string" && Array.isArray(m?.chunks) && m.chunks.length > 0;
    } catch {
      return false;
    }
  });
  if (!hasManifest) {
    test.skip(!expectHologram, "no warm-κ manifest published for this build yet");
    expect(hasManifest, "E2E_EXPECT_HOLOGRAM=1 but no warm-κ manifest is published").toBe(true);
  }

  // __HOLO_BACKEND_READY__ is set ONLY after resume → guest re-accepts → transport installed → in-guest
  // token adopted → a live protected /api/status answers, all over the loopback bridge. First load
  // fetches the warm machine, so allow generous time; cached warm-starts are seconds.
  //
  // Poll the on-window boot beacons (phase/detail/elapsed) every 3 s so a stall is fully diagnosed — we
  // see exactly which phase froze (resume vs token/auth) and the worker's pump metrics — instead of a
  // blind waitForFunction timeout. page.evaluate is reliable even when page.on("console") drops worker logs.
  const DEADLINE = Date.now() + 330_000; // streaming low-mem load (JS blake3 + decompress) + OPFS disk paging
  // + the unsettled-κ resume settle: measured ~256 s to READY locally, so 330 s gives margin without masking a
  // real hang (the per-phase beacon below still localizes any stall).
  let ready = false;
  let lastBeacon = "";
  while (Date.now() < DEADLINE) {
    const b = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        ready: w.__HOLO_BACKEND_READY__ === true,
        phase: w.__HOLO_BOOT_PHASE__ as string | undefined,
        detail: w.__HOLO_BOOT_DETAIL__ as string | undefined,
        elapsed: w.__HOLO_BOOT_ELAPSED__ as string | undefined,
        diag: w.__HOLO_DIAG__ as string | undefined,
      };
    });
    if (b.ready) { ready = true; break; }
    const beacon = `phase=${b.phase ?? "?"} detail="${b.detail ?? ""}" elapsed=${b.elapsed ?? "?"}s${b.diag ? ` diag=${b.diag}` : ""}`;
    if (beacon !== lastBeacon) { recordConsole(`[boot] ${beacon}`); lastBeacon = beacon; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) {
    recordConsole(`[boot] STALLED — last beacon: ${lastBeacon}`);
    throw new Error(`backend never became ready (260s); last boot beacon: ${lastBeacon}`);
  }
  const token = await page.evaluate(() => (window as unknown as { __HERMES_SESSION_TOKEN__?: string }).__HERMES_SESSION_TOKEN__);
  expect(typeof token === "string" && token.length > 0, "in-guest session token adopted").toBe(true);

  // FAIL-CLOSED memory gate: the boot must never materialize the whole snapshot in JS *and* wasm at once.
  // The worker measures the true peak (live JS bytes held + wasm linear-memory size) across the streamed
  // resume and beacons it. A regression to holding the full 1.9 GB buffer (or a wasm κ-verify copy) pushes
  // the peak to ~3+ GB and OOM-crashes memory-limited tabs — so we cap it well under that. This is what
  // keeps the streaming load from silently regressing.
  const peakBytes = await page.evaluate(() => (window as unknown as { __HOLO_PEAK_BYTES__?: number }).__HOLO_PEAK_BYTES__);
  expect(typeof peakBytes === "number" && peakBytes > 0, "boot peak-memory beacon present").toBe(true);
  recordConsole(`[boot] peak memory (JS+wasm) = ${((peakBytes as number) / 1e6).toFixed(0)} MB`);
  const PEAK_BUDGET = 1_600_000_000; // 1.6 GB — above the ~1.22 GB measured floor of the substrate-correct
  // path (UNIFIED sparse κ + disk paged OFF-heap to an OPFS κ-store + length-prefixed RAM read into an exact
  // buffer), with headroom for variance. Far below the ~2.3 GB of the old in-heap-disk path and the ~3.3 GB
  // that OOM-crashed memory-limited tabs. A regression that puts the disk back on the wasm heap (~+0.7 GB) or
  // reintroduces the RAM doubling transient (~+0.9 GB) or materializes the whole snapshot trips this gate.
  expect(peakBytes as number, `boot peak memory must stay under ${PEAK_BUDGET / 1e9} GB (got ${((peakBytes as number) / 1e9).toFixed(2)} GB)`).toBeLessThan(PEAK_BUDGET);

  // The real dashboard is now mounted against the in-browser backend: chrome + sidebar nav, not a stub.
  await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
  const body = await page.locator("body").innerText();
  for (const label of [/sessions/i, /models/i, /chat/i, /logs/i, /config/i]) {
    expect(body, `dashboard nav should contain ${label}`).toMatch(label);
  }
  expect(body, "must be the real dashboard, not a stub").not.toMatch(STUB);

  // Client-side routing works under the project subpath (SPA fallback + router basename keep /hermes-web).
  await page.goto("models", { waitUntil: "load" });
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 330_000 });
  expect(new URL(page.url()).pathname).toMatch(/\/models$/);
  await page.waitForTimeout(3000); // let the models page fire its reads

  // FAIL-CLOSED dashboard-latency gate. Across the whole session the worker dialed the guest only for these
  // GETs (a warm-seed hit is never dialed). The ONLY legitimate dials are /api/status (re-fetched live to
  // stay fresh, k-aligned) and the egress-gated endpoints (model/skills/mcp/messaging/hermes-update — they
  // can't be pre-seeded and fast-503 without the router). ANY other path here missed the seed and paid a
  // ~10 s single-lane round-trip — the "dashboard takes an hour" regression. Keep the seed (SAFE_WARM_PATHS)
  // in step with what the dashboard fetches.
  // /api/config is dialed once by the boot's OWN health probe (holo-worker.ts confirms the in-guest Python
  // answers a protected route, deliberately bypassing the seed) — not a dashboard read; /api/status is the
  // k-aligned live refresh; the rest are egress-gated (can't be pre-seeded, fast-503 without the router).
  const allowMiss = /^\/api\/(config\b|status\b|model\/(info|options|set|auxiliary)\b|models\b|skills|mcp\/|mcp\b|messaging\/|hermes\/update)/;
  const uniqueGets = [...new Set(guestGets)];
  const seedMisses = uniqueGets.filter((p) => !allowMiss.test(p));
  recordConsole(`[seed-gate] ${uniqueGets.length} unique guest GETs; seed-miss(es): ${seedMisses.join(", ") || "none"}`);
  expect(seedMisses, `dashboard local reads must hit the warm seed, not the slow guest lane: ${seedMisses.join(", ")}`).toEqual([]);

  // FAIL-CLOSED establishment-latency gate. The boot MUST adopt the session token from the seeded "/" rather
  // than dialing the guest — that keeps the one-time ~1.45 B-instruction first-request re-establishment (the
  // dominant boot term, ~120 s on a slow CPU) OFF the critical path; it is paid by a background warm-up dial
  // while the user already sees the fully-seeded dashboard. If the seed ever ships without "/", the boot falls
  // back to the slow first dial and this fails — the regression the seed re-capture must prevent.
  expect(seedServedAuth, 'boot must serve auth from the warm seed ("/" captured) so the establishment is deferred, not on the critical path').toBe(true);
});
