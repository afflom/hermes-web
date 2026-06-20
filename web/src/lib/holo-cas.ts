// holo-cas.ts — fetch the warm Hermes κ-snapshot the browser resumes, content-addressed and
// verified by re-derivation (Law L5; ADR-019). The snapshot is the whole serving machine
// (CPU+RAM+disk+9p) the native witness banked once (`tools/holo/witness/cc_hermes_guest.rs`); the
// browser restores it with `Workspace.resume_devcontainer_bridged` — no kernel fetch, no rootfs
// assembly, no ~24-min cold boot.
//
// Two reasons it is shipped as content-addressed CHUNKS rather than one blob:
//   1. GitHub hard-rejects any single file > 100 MB, so a multi-hundred-MB κ cannot be a lone asset.
//   2. It is the substrate's own model — a κ is a content address; its chunks are content too, each
//      pinned by its own digest and verified on read. An untrusted gateway (Pages, a CDN, OPFS) is
//      safe because trust is in the math: bytes are accepted only if re-deriving their κ reproduces it.
//
// Load order: OPFS cache (instant, L5-verified) → else fetch the manifest + chunks (each chunk
// integrity-checked, the reassembled whole L5-verified against the substrate κ), then persist to OPFS
// for next time. `kappa()` here is the wasm `hs.kappa` (substrate default axis = blake3), the SAME
// function `holospaces::address` the banking step (`cargo run --example kappa_of`) records — so the
// recorded κ and the in-browser re-derivation are the same label, and the verify is real.

export interface WarmChunk {
  /** File name under `warm/chunks/`. */
  name: string;
  /** Lowercase hex SHA-256 of the chunk's RAW (post-gunzip) bytes — per-chunk integrity. */
  sha256: string;
  /** Raw (post-gunzip) byte length of the chunk. */
  size: number;
}

export interface WarmManifest {
  /** The substrate κ-label of the whole snapshot (`blake3:<hex>`) — the Law-L5 target. */
  kappa: string;
  /** Uncompressed snapshot length in bytes (sum of chunk sizes). */
  size: number;
  /** Whether each chunk is gzip-compressed on the wire (guest RAM is mostly zero → tiny). */
  chunkGzip: boolean;
  /** Ordered chunks; concatenating their raw bytes reconstructs the snapshot. */
  chunks: WarmChunk[];
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

const OPFS_DIR = "holo-warm";

// A Uint8Array explicitly backed by an ArrayBuffer (not SharedArrayBuffer) — what the DOM/Web Crypto
// APIs require under TS's typed-array strictness.
type Bytes = Uint8Array<ArrayBuffer>;

async function gunzip(b: Uint8Array): Promise<Bytes> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(b as BodyInit).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzip(b: Uint8Array): Promise<Bytes> {
  const cs = new CompressionStream("gzip");
  const stream = new Response(b as BodyInit).body!.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
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

/** Read a previously-persisted snapshot from OPFS and L5-verify it; null on miss/corruption. */
async function readCached(kappa: string, k: KappaFn, onProgress: OnProgress): Promise<Uint8Array | null> {
  const dir = await opfsDir();
  if (!dir) return null;
  try {
    onProgress({ phase: "cache", detail: "checking local snapshot store" });
    const fh = await dir.getFileHandle(cacheKey(kappa));
    const gz = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    const snapshot = await gunzip(gz);
    // ADR-019: OPFS is durable but untrusted — accept only if it re-derives to the recorded κ.
    if (k(snapshot) === kappa) {
      onProgress({ phase: "cache", fraction: 1, detail: "restored from local snapshot store" });
      return snapshot;
    }
    // Tampered/corrupt — drop it so the fetch path repopulates.
    await dir.removeEntry(cacheKey(kappa)).catch(() => {});
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
    await w.write(gz);
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
 * Load + verify the warm snapshot. OPFS cache first; otherwise fetch the manifest, then each chunk
 * (integrity-checked by its own SHA-256), reassemble, and L5-verify the whole against the substrate κ.
 * Throws if no manifest is published or verification fails. `kappa` is the wasm `hs.kappa`.
 */
export async function loadWarmSnapshot(kappa: KappaFn, onProgress: OnProgress = () => {}): Promise<Uint8Array> {
  onProgress({ phase: "manifest", detail: "fetching warm-κ manifest" });
  const res = await fetch(warmUrl("manifest.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`no warm-κ manifest (${res.status}) — bank it with the guest witness + chunker`);
  const manifest = (await res.json()) as WarmManifest;
  if (!manifest.kappa || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error("warm-κ manifest is malformed (missing kappa/chunks)");
  }

  // Fast path: the exact snapshot already sits in OPFS, verified.
  const cached = await readCached(manifest.kappa, kappa, onProgress);
  if (cached) return cached;

  // Fetch + verify each content-addressed chunk, then concatenate into the full snapshot.
  const snapshot = new Uint8Array(manifest.size);
  let offset = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    onProgress({ phase: "chunk", fraction: i / manifest.chunks.length, detail: `fetching warm machine ${i + 1}/${manifest.chunks.length}` });
    const cr = await fetch(warmUrl(`chunks/${c.name}`), { cache: "force-cache" });
    if (!cr.ok) throw new Error(`warm-κ chunk ${c.name} fetch failed (${cr.status})`);
    let bytes = new Uint8Array(await cr.arrayBuffer());
    if (manifest.chunkGzip) bytes = await gunzip(bytes);
    // Per-chunk re-derivation: a chunk is accepted only if its bytes hash to the pinned digest.
    if ((await sha256Hex(bytes)) !== c.sha256) {
      throw new Error(`warm-κ chunk ${c.name} failed integrity (sha256 mismatch) — refusing tampered content`);
    }
    if (bytes.length !== c.size) throw new Error(`warm-κ chunk ${c.name} size mismatch`);
    snapshot.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== manifest.size) throw new Error(`warm-κ reassembly size mismatch (${offset} ≠ ${manifest.size})`);

  // Law L5: the reassembled whole must re-derive to the recorded substrate κ, or it is not the warm
  // machine the witness banked. This is the trust anchor — the gateway never has to be trusted.
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
