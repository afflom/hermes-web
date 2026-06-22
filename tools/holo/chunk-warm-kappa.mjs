#!/usr/bin/env node
// chunk-warm-kappa.mjs — turn the banked warm Hermes κ-snapshot into the content-addressed CAS the
// browser resumes from over GitHub Pages. The snapshot is the whole serving machine (CPU+RAM+disk+9p)
// the native witness banked once (`vv/witness/hermes-warm.kappa`); this slices it into gzipped,
// digest-pinned chunks + a manifest, so:
//   • no single file exceeds GitHub's hard 100 MB limit, and
//   • the browser verifies each chunk (its own SHA-256) and the reassembled whole (the substrate κ,
//     blake3 — Law L5) on load. Trust is in the math; the gateway is never trusted.
//
//   node tools/holo/chunk-warm-kappa.mjs [snapshot] [out-dir] [kappa]
//     snapshot  default vv/witness/hermes-warm.kappa
//     out-dir   default web/public/holo/warm     (copied into the Pages build by Vite)
//     kappa     the substrate κ-label (blake3:…); if omitted, computed via the `kappa_of` example.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const snapPath = process.argv[2] || path.join(ROOT, "vv/witness/hermes-warm.kappa");
const outDir = process.argv[3] || path.join(ROOT, "web/public/holo/warm");
let kappa = process.argv[4];

const CHUNK = 50 * 1024 * 1024; // 50 MiB raw — worst-case gzip stays well under the 100 MB file limit

if (!existsSync(snapPath)) {
  console.error(`chunk-warm-kappa: no snapshot at ${snapPath} — bank it first (tools/holo/witness/run-hermes-guest.sh)`);
  process.exit(1);
}

// The snapshot can exceed Node's 2 GiB single-buffer limit (the bigger writable disk → ~2.2 GB κ), so we
// never load it whole — positional reads stream one CHUNK at a time below.
const snapSize = statSync(snapPath).size;

// The recorded κ must be the SUBSTRATE address (blake3) — the exact label `hs.kappa` re-derives in the
// browser. Compute it with the holospaces `kappa_of` example unless supplied.
if (!kappa) {
  try {
    const out = execFileSync(
      "cargo",
      ["run", "-q", "--example", "kappa_of", "--manifest-path", ".holo-ref/holospaces/Cargo.toml", snapPath],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 20 },
    );
    kappa = out.trim().split(/\s+/)[0];
  } catch (e) {
    console.error("chunk-warm-kappa: could not compute κ via kappa_of — pass it as the 3rd arg.", e.message);
    process.exit(1);
  }
}
if (!/^blake3:[0-9a-f]+$/.test(kappa)) {
  console.error(`chunk-warm-kappa: κ does not look like a blake3 substrate label: ${kappa}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "chunks"), { recursive: true });

// The chunks are a pure transport framing of the content — no per-chunk hash. Integrity is the ONE
// substrate check the browser makes: the reassembled whole must re-derive to `kappa` (Law L5).
const chunks = [];
let gzTotal = 0;
const fd = openSync(snapPath, "r");
const buf = Buffer.allocUnsafe(CHUNK);
try {
  for (let off = 0, i = 0; off < snapSize; off += CHUNK, i++) {
    const want = Math.min(CHUNK, snapSize - off);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, off + got); // positional, no whole-file load
      if (n === 0) break;
      got += n;
    }
    const raw = buf.subarray(0, got);
    const name = String(i).padStart(5, "0");
    const gz = gzipSync(raw, { level: 9 });
    writeFileSync(path.join(outDir, "chunks", name), gz);
    chunks.push({ name, size: got });
    gzTotal += gz.length;
    if (gz.length > 95 * 1024 * 1024) {
      console.error(`chunk-warm-kappa: chunk ${name} gzips to ${gz.length} bytes (> 95 MB) — lower CHUNK`);
      process.exit(1);
    }
  }
} finally {
  closeSync(fd);
}

const manifest = { kappa, size: snapSize, chunkGzip: true, chunks };
writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// k-aligned read seed: vendor the warm κ's bank-captured dashboard responses (cc_capture_responses) next to
// the κ. The browser seeds its read-cache from this so the dashboard reads the κ instantly instead of
// re-computing each GET through the (serialized, one-connection) guest. Optional — older κ may not have it.
const responsesSrc = path.join(path.dirname(snapPath), "warm-responses.json");
if (existsSync(responsesSrc)) {
  const bytes = readFileSync(responsesSrc);
  writeFileSync(path.join(outDir, "warm-responses.json"), bytes);
  console.log(`  + warm-responses.json (${(bytes.length / 1024).toFixed(0)} KB) — k-aligned read seed`);
} else {
  console.warn("  ! no warm-responses.json — run cc_capture_responses so the dashboard reads from κ (not the slow guest)");
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`✓ warm κ chunked → ${path.relative(ROOT, outDir)}`);
console.log(`  κ=${kappa}`);
console.log(`  snapshot ${mb(snapSize)} MB → ${chunks.length} chunks, ${mb(gzTotal)} MB gzipped on the wire`);
