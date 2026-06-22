// holo-cas.ts — fetch the warm Hermes κ-snapshot the browser resumes, addressed and verified ENTIRELY
// by the substrate: a κ is a content address, and content is accepted only if re-deriving its κ
// reproduces it (Law L5; ADR-019, "verify by re-derivation — an untrusted gateway is safe because
// trust is in the math"). No foreign hashes, no trusted gateway.
//
// The snapshot is the whole serving machine (CPU+RAM+disk+9p) the native witness banked once
// (`tools/holo/witness/cc_hermes_guest.rs`); the browser restores it with
// `Workspace.resume_devcontainer_bridged` — no kernel fetch, no rootfs assembly, no cold boot.
//
// It is shipped as ordered chunks only because GitHub hard-rejects any single file > 100 MB — the
// chunks are a pure transport framing of the content. Their integrity is not asserted by any side
// hash; it falls out of the ONE substrate check that matters: the reassembled whole must re-derive to
// the recorded κ (`hs.kappa`, the substrate default axis = blake3 — the exact label the banking step
// `cargo run --example kappa_of` records). Equal load order, equal bytes, equal κ.

import { blake3 } from "@noble/hashes/blake3.js";
import { ungzip } from "pako";

export interface WarmManifest {
  /** The substrate κ-label of the whole snapshot (`blake3:<hex>`) — the only trust anchor. */
  kappa: string;
  /** Uncompressed snapshot length in bytes (sum of chunk sizes). */
  size: number;
  /** Whether each chunk is gzip-compressed on the wire (guest RAM is mostly zero → tiny). */
  chunkGzip: boolean;
  /** Ordered chunks; concatenating their raw bytes reconstructs the snapshot. */
  chunks: { name: string; size: number }[];
}

/** A `hs.kappa`-shaped re-derivation fn (substrate default axis, blake3). */
export type KappaFn = (bytes: Uint8Array) => string;

export interface WarmLoadProgress {
  phase: "cache" | "manifest" | "chunk" | "verify" | "persist";
  /** 0..1 within the fetch phase, when known. */
  fraction?: number;
  detail?: string;
}

type OnProgress = (p: WarmLoadProgress) => void;
type Bytes = Uint8Array<ArrayBuffer>;

const OPFS_DIR = "holo-warm";

async function gunzip(b: Uint8Array): Promise<Bytes> {
  const stream = new Response(b as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Stream-decompress a gzip source DIRECTLY into a single pre-allocated buffer of known size. Unlike
 * `gunzip` (which routes through `Response.arrayBuffer`, growing+reallocating one buffer to the full
 * size — a transient ~2× spike that fragments the heap), this writes each decompressed chunk in place.
 * For the 1.44 GB warm snapshot that's the difference between a ~1.45 GB peak and a ~2.9 GB spike — the
 * latter OOM-crashes the tab on refresh, on top of the resume itself.
 */
async function gunzipInto(gz: Uint8Array, size: number): Promise<Bytes> {
  const out = new Uint8Array(size);
  const reader = new Response(gz as BodyInit).body!.pipeThrough(new DecompressionStream("gzip")).getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > size) throw new Error("cached snapshot exceeds expected size");
    out.set(value, offset);
    offset += value.length;
  }
  if (offset !== size) throw new Error(`cached snapshot size mismatch (${offset} ≠ ${size})`);
  return out as Bytes;
}

async function gzip(b: Uint8Array): Promise<Bytes> {
  const stream = new Response(b as BodyInit).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A filesystem-safe slug for an OPFS cache key derived from the κ-label. */
function cacheKey(kappa: string): string {
  return `${kappa.replace(/[^a-zA-Z0-9._-]/g, "_")}.snapshot.gz`;
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Read a previously-persisted snapshot from OPFS and verify it by re-derivation; null on miss/corruption. */
async function readCached(manifest: WarmManifest, k: KappaFn, onProgress: OnProgress): Promise<Bytes | null> {
  const dir = await opfsDir();
  if (!dir) return null;
  try {
    onProgress({ phase: "cache", detail: "checking local snapshot store" });
    const fh = await dir.getFileHandle(cacheKey(manifest.kappa));
    const gz = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    // Stream-decompress into a pre-allocated buffer (no Response.arrayBuffer 2× spike — see gunzipInto).
    const snapshot = await gunzipInto(gz, manifest.size);
    // ADR-019: OPFS is durable but untrusted — accept only if it re-derives to the recorded κ.
    if (k(snapshot) === manifest.kappa) {
      onProgress({ phase: "cache", fraction: 1, detail: "restored from local snapshot store" });
      return snapshot;
    }
    await dir.removeEntry(cacheKey(manifest.kappa)).catch(() => {}); // corrupt — drop so the fetch path repopulates
    return null;
  } catch {
    return null;
  }
}

async function persistCache(kappa: string, snapshot: Uint8Array, onProgress: OnProgress): Promise<void> {
  const dir = await opfsDir();
  if (!dir) return;
  try {
    onProgress({ phase: "persist", detail: "saving snapshot for instant warm-start" });
    const gz = await gzip(snapshot);
    const fh = await dir.getFileHandle(cacheKey(kappa), { create: true });
    const w = await fh.createWritable();
    await w.write(gz as BufferSource);
    await w.close();
  } catch {
    /* OPFS write is a best-effort cache; the resume already has its bytes. */
  }
}

/** Base-aware URL for a warm-κ asset shipped under `${BASE}holo/warm/`. */
function warmUrl(rel: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base}holo/warm/${rel}`.replace(/([^:])\/\//g, "$1/");
}

/**
 * STREAMING warm-κ load — the low-memory path. Returns the snapshot as an ARRAY of chunk buffers (never
 * concatenated into one 1.9 GB allocation) and verifies the κ INCREMENTALLY: each chunk feeds a streaming
 * blake3 (the κ is plain blake3 over the snapshot bytes — empirically confirmed), so the Law-L5 re-derivation
 * holds WITHOUT ever copying the whole snapshot into wasm (`hs.kappa` would). The caller feeds the resume
 * window-by-window and frees each chunk as it goes, so neither JS nor wasm ever holds the full 1.9 GB — the
 * peak drops from ~3.8 GB (verify-copy + held buffer) to ~1.9 GB, which is what lets memory-limited tabs boot.
 */
export interface WarmChunks { gz: (Uint8Array | null)[]; gzip: boolean; total: number }
export async function loadWarmChunks(onProgress: OnProgress = () => {}): Promise<WarmChunks> {
  onProgress({ phase: "manifest", detail: "fetching warm-κ manifest" });
  const res = await fetch(warmUrl("manifest.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`no warm-κ manifest (${res.status}) — bank it with the guest witness + chunker`);
  const manifest = (await res.json()) as WarmManifest;
  if (!manifest.kappa || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error("warm-κ manifest is malformed (missing kappa/chunks)");
  }
  const ver = (manifest.kappa.match(/[0-9a-f]{8,}/i)?.[0] ?? manifest.kappa).slice(0, 16); // cache-bust per κ
  const hasher = blake3.create();
  // Keep the COMPRESSED chunks (~390 MB) — NOT the 1.9 GB of decompressed bytes. Each is decompressed once
  // here only to feed the incremental κ verify, then the raw is dropped; the caller re-inflates on-demand
  // during the feed (one chunk at a time). So the JS side never holds the whole snapshot → ~1.9 GB peak.
  const gz: (Uint8Array | null)[] = [];
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    onProgress({ phase: "chunk", fraction: i / manifest.chunks.length, detail: `fetching warm machine ${i + 1}/${manifest.chunks.length}` });
    const cr = await fetch(`${warmUrl(`chunks/${c.name}`)}?v=${ver}`, { cache: "force-cache" });
    if (!cr.ok) throw new Error(`warm-κ chunk ${c.name} fetch failed (${cr.status})`);
    const comp = new Uint8Array(await cr.arrayBuffer());
    const raw = manifest.chunkGzip ? ungzip(comp) : comp; // decompress to VERIFY only; raw is GC'd after update
    if (raw.length !== c.size) throw new Error(`warm-κ chunk ${c.name} size mismatch`);
    hasher.update(raw); // incremental Law-L5 verify — no whole-snapshot materialization
    gz.push(manifest.chunkGzip ? comp : raw);
  }
  // Law L5 — the SINGLE trust anchor: the streamed whole must re-derive to the recorded substrate κ.
  onProgress({ phase: "verify", detail: "verifying warm machine by re-derivation (Law L5)" });
  const hex = Array.from(hasher.digest(), (b) => b.toString(16).padStart(2, "0")).join("");
  if (`blake3:${hex}` !== manifest.kappa) {
    throw new Error(`warm-κ failed re-derivation: got blake3:${hex}, expected ${manifest.kappa}`);
  }
  return { gz, gzip: manifest.chunkGzip, total: manifest.size };
}

/** One bank-captured dashboard read: the warm κ's already-computed response (body is lowercase hex). */
export interface WarmResponse { status: number; ct: string; body: string }
/**
 * Load the bank-captured dashboard responses — the k-aligned read seed. The warm κ computed each of these
 * GETs once at bank time; the browser serves them from this content-addressed artifact so the dashboard
 * reads the κ instantly instead of re-computing through the interpreter (~2-3 s each, serialized because the
 * guest serves one loopback connection at a time). Returns null if not published (older κ) — callers fall
 * back to live round-trips.
 */
export async function loadWarmResponses(): Promise<Record<string, WarmResponse> | null> {
  try {
    const res = await fetch(warmUrl("warm-responses.json"), { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, WarmResponse>;
  } catch {
    return null;
  }
}

/**
 * Load + verify the warm snapshot. OPFS cache first; otherwise fetch the manifest, fetch each chunk,
 * reassemble, and verify the whole by re-derivation against the substrate κ. Throws if no manifest is
 * published or verification fails. `kappa` is the wasm `hs.kappa`.
 */
export async function loadWarmSnapshot(kappa: KappaFn, onProgress: OnProgress = () => {}): Promise<Bytes> {
  onProgress({ phase: "manifest", detail: "fetching warm-κ manifest" });
  const res = await fetch(warmUrl("manifest.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`no warm-κ manifest (${res.status}) — bank it with the guest witness + chunker`);
  const manifest = (await res.json()) as WarmManifest;
  if (!manifest.kappa || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error("warm-κ manifest is malformed (missing kappa/chunks)");
  }

  // Fast path: the exact snapshot already sits in OPFS, verified by re-derivation.
  const cached = await readCached(manifest, kappa, onProgress);
  if (cached) return cached;

  // Fetch each chunk and concatenate into the full snapshot (pure transport framing). Chunk file names are
  // positional (00000…) and STABLE across deploys, but their contents change whenever the κ is re-banked —
  // and a re-bank can shift chunk boundaries, so an old cached chunk has the wrong size for the new manifest.
  // `force-cache` would happily serve that stale chunk → "size mismatch". Version the URL by the κ hash: the
  // chunks are immutable *per κ* (cache them hard), but a new κ yields new URLs that bypass every stale cache
  // (browser + Pages/Fastly edge). The manifest itself is always fetched no-cache, so the κ is always current.
  const ver = (manifest.kappa.match(/[0-9a-f]{8,}/i)?.[0] ?? manifest.kappa).slice(0, 16);
  const snapshot = new Uint8Array(manifest.size);
  let offset = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    onProgress({ phase: "chunk", fraction: i / manifest.chunks.length, detail: `fetching warm machine ${i + 1}/${manifest.chunks.length}` });
    const cr = await fetch(`${warmUrl(`chunks/${c.name}`)}?v=${ver}`, { cache: "force-cache" });
    if (!cr.ok) throw new Error(`warm-κ chunk ${c.name} fetch failed (${cr.status})`);
    const bytes = manifest.chunkGzip ? await gunzip(new Uint8Array(await cr.arrayBuffer())) : new Uint8Array(await cr.arrayBuffer());
    if (bytes.length !== c.size) throw new Error(`warm-κ chunk ${c.name} size mismatch`);
    snapshot.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== manifest.size) throw new Error(`warm-κ reassembly size mismatch (${offset} ≠ ${manifest.size})`);

  // Law L5 — the SINGLE trust anchor: the reassembled whole must re-derive to the recorded substrate κ,
  // or it is not the warm machine the witness banked. Corruption anywhere (a bad chunk, a truncated
  // fetch, a tampering gateway) fails here. The gateway never has to be trusted.
  onProgress({ phase: "verify", detail: "verifying warm machine by re-derivation (Law L5)" });
  const derived = kappa(snapshot);
  if (derived !== manifest.kappa) {
    throw new Error(`warm-κ failed re-derivation: got ${derived}, expected ${manifest.kappa}`);
  }

  await persistCache(manifest.kappa, snapshot, onProgress);
  return snapshot;
}

/** Whether a warm-κ manifest is published for this deploy (cheap HEAD; no download). */
export async function hasWarmManifest(): Promise<boolean> {
  try {
    const res = await fetch(warmUrl("manifest.json"), { method: "HEAD", cache: "no-cache" });
    return res.ok;
  } catch {
    return false;
  }
}
