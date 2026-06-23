import { describe, it, expect, beforeAll } from "vitest";
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bootNativeBackend, type NativeBackend, type NativeManifest } from "./runtime";

// G1/G2 gate for the native-exec Hermes backend: the REAL runtime boots the REAL Hermes Python under Pyodide
// and serves real /api reads + writes native-fast (the emulated interpreter wall took >360 s). DRY — this tests
// the production runtime.ts + the build artifacts, not a bespoke harness.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NATIVE = path.join(REPO, "web/public/native");
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("native-exec Hermes backend", () => {
  let backend: NativeBackend;

  beforeAll(async () => {
    // Build the artifacts from the REAL source (the same step the dashboard build runs).
    execFileSync("node", ["web/scripts/bundle-hermes-native.mjs"], { cwd: REPO });
    const manifest = JSON.parse(readFileSync(path.join(NATIVE, "deps.json"), "utf8")) as NativeManifest;
    const sourceTar = readFileSync(path.join(NATIVE, "hermes-src.tar"));
    const osSurfacePy = readFileSync(path.join(REPO, "web/src/native/os_surface.py"), "utf8");
    const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
    backend = await bootNativeBackend(py as never, { manifest, sourceTar, osSurfacePy });
  }, 180_000);

  it("G1: the full unmodified Hermes app boots native and yields a session token", () => {
    expect(backend.token).toBeTruthy();
    expect(backend.token.length).toBeGreaterThan(8);
  });

  it("G2: a real GET /api/config returns 200 native-fast (was >360 s emulated)", async () => {
    const auth = { authorization: `Bearer ${backend.token}` };
    await backend.request("GET", "/api/config", auth); // warm
    const t0 = performance.now();
    const r = await backend.request("GET", "/api/config", auth);
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(2000);
  });

  it("G2: a real local MUTATION round-trips native (create cron job → list → delete)", async () => {
    const auth = { authorization: `Bearer ${backend.token}`, "content-type": "application/json" };
    const made = await backend.request("POST", "/api/cron/jobs?profile=default", auth,
      enc(JSON.stringify({ name: "native_probe_job", prompt: "x", schedule: "0 9 * * 1" })));
    expect(made.status, dec(made.body)).toBeLessThan(300);
    const id = JSON.parse(dec(made.body)).id as string;
    const list = await backend.request("GET", "/api/cron/jobs?profile=default", { authorization: `Bearer ${backend.token}` });
    expect(list.status).toBe(200);
    expect(dec(list.body)).toContain("native_probe_job"); // the write persisted + is read back, all native
    await backend.request("DELETE", `/api/cron/jobs/${id}?profile=default`, auth);
  });
});
