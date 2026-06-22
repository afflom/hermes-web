import { describe, it, expect } from "vitest";
import { resourceOf, keysToInvalidateOnMutation } from "./holo-cache";

// BDD for the k-alignment-survives-writes property: a mutation must NOT knock unrelated dashboard reads off
// the warm-κ seed (the whole-cache wipe was the dominant flakiness — one save made the entire dashboard slow).

const SEED = [
  "/api/config",
  "/api/config/schema",
  "/api/config/raw",
  "/api/sessions?limit=20&offset=0&order=created",
  "/api/sessions/stats",
  "/api/cron/jobs?profile=all",
  "/api/cron/delivery-targets",
  "/api/system/stats",
  "/api/memory",
];

function invalidate(mutatedBare: string, cacheKeys: string[], seeded: Set<string>): Set<string> {
  const dead = keysToInvalidateOnMutation(mutatedBare, cacheKeys, (k) => seeded.has(k));
  return new Set(cacheKeys.filter((k) => !dead.includes(k))); // what SURVIVES
}

describe("keysToInvalidateOnMutation (k-aligned read cache)", () => {
  it("derives the mutated resource from the first two path segments", () => {
    expect(resourceOf("/api/cron/jobs/3/pause")).toBe("/api/cron");
    expect(resourceOf("/api/config")).toBe("/api/config");
    expect(resourceOf("/api/sessions/bulk-delete")).toBe("/api/sessions");
    expect(resourceOf("/api/tools/toolsets/foo/env")).toBe("/api/tools");
  });

  it("a cron write keeps ALL unrelated κ reads instant (config/sessions/system/memory survive)", () => {
    const seeded = new Set(SEED);
    const survives = invalidate("/api/cron/jobs/3/pause", [...SEED], seeded);
    // Unrelated seeds stay — the dashboard does NOT fall back to the slow lane.
    for (const k of ["/api/config", "/api/config/schema", "/api/sessions/stats", "/api/system/stats", "/api/memory"]) {
      expect(survives.has(k), `${k} should survive a cron mutation`).toBe(true);
    }
    // The cron reads ARE dropped (read-after-write: the user sees their change).
    expect(survives.has("/api/cron/jobs?profile=all")).toBe(false);
    expect(survives.has("/api/cron/delivery-targets")).toBe(false);
  });

  it("a config write invalidates every config read but nothing else", () => {
    const seeded = new Set(SEED);
    const survives = invalidate("/api/config", [...SEED], seeded);
    expect(survives.has("/api/config")).toBe(false);
    expect(survives.has("/api/config/schema")).toBe(false);
    expect(survives.has("/api/config/raw")).toBe(false);
    expect(survives.has("/api/sessions/stats")).toBe(true);
    expect(survives.has("/api/cron/jobs?profile=all")).toBe(true);
  });

  it("always drops non-seeded entries (a write may have changed any fresh read)", () => {
    const seeded = new Set(SEED);
    const keys = [...SEED, "/api/foo/bar", "/api/widgets?x=1"];
    const survives = invalidate("/api/cron/jobs", keys, seeded);
    expect(survives.has("/api/foo/bar"), "non-seeded entry dropped").toBe(false);
    expect(survives.has("/api/widgets?x=1"), "non-seeded entry dropped").toBe(false);
    expect(survives.has("/api/config"), "unrelated seed kept").toBe(true);
  });

  it("matches query-stringed seed keys by their bare path", () => {
    const seeded = new Set(SEED);
    const survives = invalidate("/api/sessions/abc/rename", [...SEED], seeded);
    // both the paged list AND stats are under /api/sessions → invalidated
    expect(survives.has("/api/sessions?limit=20&offset=0&order=created")).toBe(false);
    expect(survives.has("/api/sessions/stats")).toBe(false);
    // cron/config untouched
    expect(survives.has("/api/cron/jobs?profile=all")).toBe(true);
    expect(survives.has("/api/config")).toBe(true);
  });
});
