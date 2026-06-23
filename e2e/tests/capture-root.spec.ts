import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(HERE, "../../web/public/holo/warm/warm-responses.json");

// Capture ONLY "/" (the dashboard HTML carrying the frozen session token) and MERGE it into the SHIPPED warm
// seed, enabling seed-served auth (holo-worker `tokenFromSeed`) so the boot skips the ~1.45 B-instruction
// first-dial establishment (it is paid in the background by the existing /api/config health probe instead).
// Split from the full capture-seed because "/" is a single fast read — robust on any box — while re-capturing
// all 43 heavy reads (e.g. /api/status ~100 s) serializes on the one guest lane and is slow/flaky. Excluded
// from the deploy gate (which runs only deployment.spec + features.spec). Run manually after a re-bank:
//   BUILD=1 E2E_EXPECT_HOLOGRAM=1 e2e/run.sh -g "capture / into"
test("capture / into the warm seed for seed-served auth", async ({ page }) => {
  test.setTimeout(600_000);
  page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[browser:pageerror] ${e.message}`));

  await page.goto("./", { waitUntil: "load" });
  await page.waitForFunction("window.__HOLO_BACKEND_READY__ === true", null, { timeout: 400_000 });
  await page.waitForFunction("typeof window.__HOLO_CAPTURE__ === 'function'", null, { timeout: 5_000 });

  // The RAW capture hook dials the guest directly for "/". By now adoptToken has already paid the
  // establishment (this seed has no "/" yet, so the boot fell back to dialing), so this read is fast.
  const root = await page.evaluate(async () => {
    const hex = (buf: ArrayBuffer) =>
      Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    const res = await (window as unknown as { __HOLO_CAPTURE__: (p: string) => Promise<Response> }).__HOLO_CAPTURE__("/");
    const buf = await res.arrayBuffer();
    return { status: res.status, ct: res.headers.get("content-type") || "text/html; charset=utf-8", body: hex(buf) };
  });

  expect(root.status, '"/" must capture a 200 dashboard HTML').toBe(200);
  expect(Buffer.from(root.body, "hex").toString("utf8"), '"/" must carry the frozen session token').toMatch(
    /__HERMES_SESSION_TOKEN__\s*=\s*"[^"]+"/,
  );

  const seed = JSON.parse(readFileSync(SEED, "utf8")) as Record<string, unknown>;
  seed["/"] = root;
  writeFileSync(SEED, `${JSON.stringify(seed, null, 0)}\n`);
  console.log(
    `[capture-root] merged "/" (${Buffer.from(root.body, "hex").length}B) into the shipped seed → ${Object.keys(seed).length} entries`,
  );
});
