import { describe, it, expect, afterEach, vi } from "vitest";
import { loadWarmSnapshot } from "./holo-cas";

// The content-addressed warm-κ codec, evaluated in a REAL browser — it relies on browser APIs
// (CompressionStream/DecompressionStream, fetch, OPFS) that don't exist in node. We mock only the
// network (the gateway): the manifest + gzipped chunks. The trust check (Law L5 re-derivation) is real.

// A deterministic, synchronous stand-in for the substrate κ (the real one is wasm `hs.kappa`/blake3).
// FNV-1a over the bytes — enough to prove reassembly + re-derivation wiring end to end.
function fakeKappa(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `blake3:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

async function gzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Response(b as BodyInit).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Build a snapshot + its CAS (manifest + gzipped chunks) and a fetch that serves them. */
async function buildCas(snapshot: Uint8Array, chunkSize: number) {
  const chunks: { name: string; size: number }[] = [];
  const gzByName = new Map<string, Uint8Array>();
  for (let off = 0, i = 0; off < snapshot.length; off += chunkSize, i++) {
    const raw = snapshot.subarray(off, Math.min(off + chunkSize, snapshot.length));
    const name = String(i).padStart(5, "0");
    chunks.push({ name, size: raw.length });
    gzByName.set(name, await gzip(raw));
  }
  const manifest = { kappa: fakeKappa(snapshot), size: snapshot.length, chunkGzip: true, chunks };
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("manifest.json")) return new Response(JSON.stringify(manifest), { status: 200 });
    const m = u.match(/chunks\/(\d+)$/);
    if (m) {
      const gz = gzByName.get(m[1]);
      if (gz) return new Response(gz as BodyInit, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return { manifest, fetchImpl, gzByName };
}

describe("loadWarmSnapshot (browser CAS codec)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches manifest + gzipped chunks, reassembles, and re-derives the recorded κ (Law L5)", async () => {
    const snapshot = new Uint8Array(70_000);
    for (let i = 0; i < snapshot.length; i++) snapshot[i] = (i * 31 + 7) & 0xff;
    const { fetchImpl, manifest } = await buildCas(snapshot, 16_384);
    expect(manifest.chunks.length).toBeGreaterThan(1); // multi-chunk path exercised
    vi.stubGlobal("fetch", fetchImpl);

    const got = await loadWarmSnapshot(fakeKappa);
    expect(got.length).toBe(snapshot.length);
    expect(Array.from(got.slice(0, 64))).toEqual(Array.from(snapshot.slice(0, 64)));
    expect(fakeKappa(got)).toBe(manifest.kappa);
  });

  it("REFUSES a tampered chunk (re-derivation no longer matches the recorded κ)", async () => {
    const snapshot = new Uint8Array(40_000).map((_, i) => (i * 13) & 0xff);
    const { fetchImpl, gzByName } = await buildCas(snapshot, 16_384);
    // Corrupt the first chunk's compressed bytes so the reassembled whole differs.
    const first = [...gzByName.keys()][0];
    const bad = await gzip(new Uint8Array(16_384).fill(0xab));
    gzByName.set(first, bad);
    vi.stubGlobal("fetch", fetchImpl);

    await expect(loadWarmSnapshot(fakeKappa)).rejects.toThrow(/re-derivation|size mismatch/i);
  });

  it("throws a clear error when no warm-κ manifest is published (404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(loadWarmSnapshot(fakeKappa)).rejects.toThrow(/no warm-κ manifest/i);
  });
});
