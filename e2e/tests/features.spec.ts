import { test, expect, type Page } from "@playwright/test";
import { appendFileSync } from "node:fs";

// Comprehensive BDD gate: every hermes-web feature, end to end, against the REAL in-browser holospaces
// backend (the warm-κ guest). One boot, then each feature is exercised over the live loopback bridge —
// both its backend endpoint (via window.__HOLO_FETCH__, the worker transport with the session token) AND
// its UI route (client-side nav, so the single backend boot is reused). A hermes-agent user expects every
// panel to load real data and function; this asserts exactly that, and fails closed if any panel errors.
//
// Tiers: LOCAL features render from in-guest state and are always asserted. EGRESS features (the agent
// chat round-trip, provider/connectivity probes, hub search, the docs iframe) need outbound network —
// in production via the chrome router extension, in CI via the native gateway — and are asserted only when
// E2E_EGRESS_GATEWAY=1 (the native extension implementation is wired).

const CONSOLE_LOG = process.env.E2E_CONSOLE_LOG;
function record(line: string): void {
  console.log(line);
  if (CONSOLE_LOG) { try { appendFileSync(CONSOLE_LOG, line + "\n"); } catch { /* best effort */ } }
}

const EGRESS = process.env.E2E_EGRESS_GATEWAY === "1";

// Each feature: its nav label (accessible name of the sidebar link), client route, the backend endpoint(s)
// it loads, and whether rendering its primary data needs outbound network. `local` endpoints must answer
// 200 with the in-guest server; egress endpoints are only probed when the gateway is wired.
interface Feature {
  name: string;
  label: string; // sidebar link accessible name (text or aria-label)
  route: RegExp;
  endpoints: { path: string; egress?: boolean; timeoutMs?: number }[];
}

const FEATURES: Feature[] = [
  { name: "Sessions", label: "Sessions", route: /\/sessions$/, endpoints: [{ path: "/api/sessions?limit=20&offset=0&order=created" }] },
  { name: "Files", label: "Files", route: /\/files$/, endpoints: [{ path: "/api/files" }] },
  { name: "Analytics", label: "Analytics", route: /\/analytics$/, endpoints: [{ path: "/api/analytics/usage?days=7" }] },
  // Models probes the configured LLM providers' availability → outbound network (very slow under NoEgress).
  { name: "Models", label: "Models", route: /\/models$/, endpoints: [{ path: "/api/model/info", egress: true }, { path: "/api/model/options", egress: true }] },
  { name: "Logs", label: "Logs", route: /\/logs$/, endpoints: [{ path: "/api/logs?file=agent&lines=50" }] },
  { name: "Cron", label: "Cron", route: /\/cron$/, endpoints: [{ path: "/api/cron/jobs" }] },
  // Skills lists local skills but checks the skills hub for each → outbound network (slow under NoEgress).
  { name: "Skills", label: "Skills", route: /\/skills$/, endpoints: [{ path: "/api/skills", egress: true }, { path: "/api/skills/hub/search?q=git&limit=5", egress: true }] },
  { name: "Plugins", label: "Plugins", route: /\/plugins$/, endpoints: [{ path: "/api/dashboard/plugins" }] },
  // MCP lists configured servers and probes each one's reachability → needs outbound network.
  { name: "MCP", label: "MCP", route: /\/mcp$/, endpoints: [{ path: "/api/mcp/servers", egress: true }] },
  // Channels probes each messaging platform's live connectivity, so listing them needs outbound network.
  { name: "Channels", label: "Channels", route: /\/channels$/, endpoints: [{ path: "/api/messaging/platforms", egress: true }] },
  { name: "Webhooks", label: "Webhooks", route: /\/webhooks$/, endpoints: [{ path: "/api/webhooks" }] },
  { name: "Pairing", label: "Pairing", route: /\/pairing$/, endpoints: [{ path: "/api/pairing" }] },
  { name: "Profiles", label: "Profiles", route: /\/profiles$/, endpoints: [{ path: "/api/profiles" }, { path: "/api/profiles/active" }] },
  { name: "Config", label: "Config", route: /\/config$/, endpoints: [{ path: "/api/config" }, { path: "/api/config/schema" }] },
  { name: "Keys", label: "Keys", route: /\/env$/, endpoints: [{ path: "/api/env" }] },
  // /api/status is the k-aligned special case (served from a cached κ, re-derived only when the loop is
  // idle — see holo-worker), so it is verified separately below; the fast strict System signal is system/stats.
  { name: "System", label: "System", route: /\/system$/, endpoints: [{ path: "/api/system/stats" }] },
];

/** Boot the in-browser backend once and adopt the session token (warm-κ resume). */
async function bootBackend(page: Page): Promise<void> {
  page.on("console", (m) => record(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => record(`[browser:pageerror] ${e.message}`));
  await page.goto("./", { waitUntil: "load" });

  const hasManifest = await page.evaluate(async () => {
    try {
      const r = await fetch("holo/warm/manifest.json", { cache: "no-cache" });
      if (!r.ok) return false;
      const m = await r.json();
      return typeof m?.kappa === "string" && Array.isArray(m?.chunks) && m.chunks.length > 0;
    } catch { return false; }
  });
  test.skip(!hasManifest && process.env.E2E_EXPECT_HOLOGRAM !== "1", "no warm-κ manifest published");
  expect(hasManifest, "warm-κ manifest must be published").toBe(true);

  // Pre-settled κ resumes ready and serves immediately; allow generous time for the first cold CAS fetch.
  const DEADLINE = Date.now() + 260_000; // streaming low-mem load (JS blake3 + decompress) is slower but bounded
  let ready = false;
  while (Date.now() < DEADLINE) {
    const b = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { ready: w.__HOLO_BACKEND_READY__ === true, phase: w.__HOLO_BOOT_PHASE__, elapsed: w.__HOLO_BOOT_ELAPSED__ };
    });
    if (b.ready) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(ready, "in-browser backend became ready").toBe(true);
  const token = await page.evaluate(() => (window as unknown as { __HERMES_SESSION_TOKEN__?: string }).__HERMES_SESSION_TOKEN__);
  expect(typeof token === "string" && token.length > 0, "session token adopted").toBe(true);
  record(`[features] backend ready, token adopted`);
}

/** Call a guest endpoint through the worker transport (auth token attached). */
async function guestFetch(page: Page, path: string, timeoutMs = 60_000): Promise<{ status: number; ok: boolean; body: string }> {
  return page.evaluate(
    async ({ p, t }) => {
      const w = window as unknown as { __HOLO_FETCH__?: (path: string, init?: RequestInit) => Promise<Response> };
      if (!w.__HOLO_FETCH__) return { status: 0, ok: false, body: "no __HOLO_FETCH__" };
      const timeout = new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), t));
      try {
        const res = (await Promise.race([w.__HOLO_FETCH__(p), timeout])) as Response;
        const body = await res.text();
        return { status: res.status, ok: res.ok, body: body.slice(0, 300) };
      } catch (e) {
        return { status: 0, ok: false, body: String(e) };
      }
    },
    { p: path, t: timeoutMs },
  );
}

test("every hermes-web feature loads real data from the in-browser backend (BDD, one boot)", async ({ page }) => {
  test.setTimeout(600_000);
  await bootBackend(page);

  // ── Tier 1: each feature's backend endpoint answers from the in-guest server ───────────────────────
  for (const feat of FEATURES) {
    for (const ep of feat.endpoints) {
      if (ep.egress && !EGRESS) {
        record(`[features] ${feat.name} ${ep.path} — SKIP (needs egress gateway)`);
        continue;
      }
      const r = await guestFetch(page, ep.path, ep.timeoutMs ?? 60_000);
      record(`[features] ${feat.name} ${ep.path} → ${r.status} (${r.body.length}B)`);
      expect(r.ok, `${feat.name}: ${ep.path} must answer 2xx from the in-guest server (got ${r.status}: ${r.body})`).toBe(true);
    }
  }

  // ── Tier 2: each feature's UI route renders over the live backend (client-side nav, one boot) ──────
  for (const feat of FEATURES) {
    const isEgress = feat.endpoints.some((e) => e.egress);
    // Without a gateway, navigating to an egress page (Models/Skills/MCP/Channels) triggers an egress fetch
    // (e.g. ModelInfoCard → /api/model/info) that can't complete and HOLDS the guest's single loopback
    // connection until it times out — starving every local read behind it. Their data path is covered by the
    // EGRESS tier when the gateway is wired; here we skip the nav (the route + panel exist in production).
    if (isEgress && !EGRESS) {
      record(`[features] ${feat.name} UI — SKIP nav (egress page needs the gateway)`);
      continue;
    }
    // Navigate by clicking the sidebar link whose href matches the route path (deterministic, unlike the
    // accessible name which varies with icon/i18n/badges). Some features expose a backend endpoint but no
    // top-level nav link (e.g. analytics is surfaced inside other pages) — those are verified in Tier 1 only.
    const navPath = feat.route.source.replace(/\\\//g, "/").replace(/\$$/, ""); // /\/env$/ → "/env"
    const links = page.locator(`a[href$="${navPath}"]`);
    const cnt = await links.count();
    if (cnt === 0) {
      record(`[features] ${feat.name} UI — SKIP nav (no sidebar link; endpoint verified in Tier 1)`);
      continue;
    }
    let idx = 0;
    for (let i = 0; i < cnt; i++) { if (await links.nth(i).isVisible().catch(() => false)) { idx = i; break; } }
    const link = links.nth(idx);
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.click({ timeout: 25_000 });
    await expect(page, `${feat.name} route`).toHaveURL(feat.route);
    // The page mounted real content (the SPA root has children).
    await page.waitForFunction("(document.querySelector('#root')?.childElementCount ?? 0) > 0");
    // Local features must show no backend load error. Egress features legitimately can't load their data
    // without the router extension/gateway, so we only require their panel to mount (the feature is present
    // and would work in production); their data path is covered by the EGRESS tier when the gateway is wired.
    if (!isEgress || EGRESS) {
      const body = await page.locator("body").innerText();
      expect(body, `${feat.name}: must not show a backend load error`).not.toMatch(/failed to load|error loading|couldn.t (load|reach)|backend unavailable/i);
    }
    record(`[features] ${feat.name} UI rendered at ${new URL(page.url()).pathname}${isEgress && !EGRESS ? " (egress — panel-only)" : ""}`);
  }

  // ── Tier 3 (egress): the agent chat round-trip — the core hermes-agent experience ──────────────────
  if (EGRESS) {
    record(`[features] EGRESS: exercising the agent chat round-trip`);
    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page).toHaveURL(/\/chat$/);
    // A PTY WebSocket opens to the in-guest agent and the terminal renders output.
    const opened = await page.evaluate(async () => {
      const w = window as unknown as { __HOLO_WS__?: (path: string) => WebSocket };
      if (!w.__HOLO_WS__) return false;
      const ws = w.__HOLO_WS__("/api/pty?channel=e2e-" + Math.random().toString(36).slice(2));
      return await new Promise<boolean>((resolve) => {
        const to = setTimeout(() => resolve(false), 30_000);
        ws.onopen = () => { clearTimeout(to); resolve(true); };
        ws.onerror = () => { clearTimeout(to); resolve(false); };
      });
    });
    expect(opened, "agent PTY WebSocket opened over the loopback bridge").toBe(true);
    record(`[features] EGRESS: agent PTY opened`);
  } else {
    record(`[features] EGRESS tier SKIPPED (set E2E_EGRESS_GATEWAY=1 with the native gateway to run it)`);
  }

  // ── /api/status (k-aligned): served from a cached κ, re-derived only when the loop is idle. We've
  // stopped issuing feature fetches, so the loop now goes idle and the worker's idle refresher derives the
  // status κ (~100 s under emulation). Poll until it answers 200 — proving the status is functional WITHOUT
  // ever blocking a real request (which is the whole point: the dashboard reads the κ, never re-computes).
  record(`[features] /api/status: waiting for the idle refresher to derive the status κ…`);
  let statusOk = false;
  const sDeadline = Date.now() + 160_000;
  while (Date.now() < sDeadline) {
    const r = await guestFetch(page, "/api/status", 5_000);
    if (r.status === 200) { statusOk = true; break; }
    await new Promise((res) => setTimeout(res, 3000));
  }
  expect(statusOk, "/api/status is derived (k-aligned) and answers 200 once the loop is idle").toBe(true);
  record(`[features] /api/status → 200 (k-aligned, derived when idle)`);

  record(`[features] ✓ all asserted features functional`);
});
