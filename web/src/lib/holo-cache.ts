// Pure cache-invalidation policy for the in-browser backend's read cache, factored out of the Web Worker
// so it is unit-testable in node (the worker module itself binds `self`/DedicatedWorkerGlobalScope at load).
//
// The dashboard's reads are served from a content-addressed warm-κ SEED — instant, k-aligned. A mutation
// (POST/PUT/PATCH/DELETE) can change some reads, but wiping the WHOLE seed would knock the entire dashboard
// back onto the slow single guest lane after any save/toggle/delete (the dominant source of flakiness). So a
// mutation invalidates only what it could have changed: every non-seeded short-TTL entry, plus the κ-seeded
// reads UNDER THE MUTATED RESOURCE (so the user still sees their own write), keeping unrelated κ reads instant.

/** The mutated resource = the first two path segments, e.g. `/api/cron/jobs/3/pause` → `/api/cron`. */
export function resourceOf(barePath: string): string {
  return barePath.replace(/^(\/api\/[^/]+).*/, "$1");
}

/**
 * Given the mutated request's bare path (no query), the current cache keys, and a predicate for which keys
 * are κ-seeded, return the keys to drop: all non-seeded keys, plus seeded keys under the mutated resource.
 * Unrelated seeded keys are KEPT (they stay instant).
 */
export function keysToInvalidateOnMutation(
  bareMutatedPath: string,
  cacheKeys: Iterable<string>,
  isSeeded: (key: string) => boolean,
): string[] {
  const resource = resourceOf(bareMutatedPath);
  const dead: string[] = [];
  for (const k of cacheKeys) {
    const kb = k.split("?")[0];
    const related = kb === bareMutatedPath || kb === resource || kb.startsWith(resource + "/");
    if (!isSeeded(k) || related) dead.push(k);
  }
  return dead;
}
