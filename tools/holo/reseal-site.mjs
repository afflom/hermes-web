#!/usr/bin/env node
// reseal-site.mjs — after folding the Hermes app into the assembled `_site`, bring the served image's
// trust chain back in step so the authoritative Hologram-OS Service Worker (holo-fhs-sw.js) accepts it.
//
// The frame's SW re-derives every in-scope byte to its κ and REFUSES a mismatch (409, Law L5). It also
// pins os-closure.json itself with a baked anchor `CLOSURE_KAPPA`; if os-closure.json doesn't re-derive
// to that anchor the SW fails CLOSED and refuses EVERY request (G1/SEC-1). Folding an app edits the
// catalog + os-closure (apps[] + closure), which (a) drifts per-path pins and (b) changes os-closure's
// own hash. So after assemble-site.mjs we must, on `_site`:
//   1. reseal every drifted closure key to the κ of the bytes the κ-route actually serves (the
//      reseal-drift.mjs algorithm, dual sha256 ⊕ blake3 axes + atlas coordinate preserved), then
//   2. re-anchor the SW's CLOSURE_KAPPA to the new sha256(os-closure.json).
// Result: a self-consistent sealed image the authoritative SW trusts and serves (Hermes included).
//
//   OUT=_site node tools/holo/reseal-site.mjs
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const OUT = resolve(process.env.OUT || "_site");
const CLOSURE = join(OUT, "etc/os-closure.json");
const SW = join(OUT, "holo-fhs-sw.js");
const fail = (m) => { console.error("✗ reseal-site: " + m); process.exit(1); };
if (!existsSync(CLOSURE)) fail(`no os-closure.json under ${OUT} — run assemble-site.mjs first`);
if (!existsSync(SW)) fail(`no holo-fhs-sw.js under ${OUT}`);

// The served image carries its own substrate modules — use them so the reseal is byte-faithful to the
// frame's own κ derivation (the same fhsMap the SW resolves through, the same σ-axis + atlas).
const { fhsMap } = await import(pathToFileURL(join(OUT, "lib/holo-fhs-map.mjs")));
const { blake3hex } = await import(pathToFileURL(join(OUT, "usr/lib/holo/holo-blake3.mjs")));
const { atlasCoord, ATLAS } = await import(pathToFileURL(join(OUT, "usr/lib/holo/holo-atlas-coord.mjs")));

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// Recompute a closure entry from the served bytes — identical shape to reseal-drift.mjs, preserving the
// dual-axis anchoring (did:holo:sha256 serve key ⊕ did:holo:blake3 substrate anchor ⊕ atlas placement).
const entry = (buf, old = {}) => {
  const dig = createHash("sha256").update(buf).digest();
  const e = {
    kappa: "did:holo:sha256:" + dig.toString("hex"),
    sri: "sha256-" + dig.toString("base64"),
    multibase: "u" + Buffer.concat([Buffer.from([0x12, 0x20]), dig]).toString("base64url"),
    bytes: buf.length,
  };
  if (Array.isArray(old.alsoKnownAs) && old.alsoKnownAs.some((a) => /blake3/.test(String(a)))) {
    const blakeHex = blake3hex(buf);
    e.alsoKnownAs = [...old.alsoKnownAs.filter((a) => !/blake3/.test(String(a))), "did:holo:blake3:" + blakeHex];
    if (old["holo:within"]) e["holo:within"] = ATLAS.object;
    if (old["holo:atlasCoordinate"]) e["holo:atlasCoordinate"] = atlasCoord(blakeHex);
  }
  return e;
};

// ── 1. reseal drifted per-path pins (the reseal-drift.mjs algorithm, run against _site) ──────────────
const doc = JSON.parse(readFileSync(CLOSURE, "utf8"));
const closure = doc.closure || {};
let drifted = 0;
for (const [key, old] of Object.entries(closure)) {
  const phys = fhsMap(key) || key;
  const abs = join(OUT, phys);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue; // missing → not served → never 409
  const e = entry(readFileSync(abs), old);
  const ob = (old.alsoKnownAs || []).find((a) => /blake3/.test(String(a))) || null;
  const nb = (e.alsoKnownAs || []).find((a) => /blake3/.test(String(a))) || null;
  if (e.kappa === old.kappa && ob === nb) continue;
  closure[key] = e;
  drifted++;
}
// Keep the recorded file count honest if assemble added closure keys.
doc.files = Object.keys(closure).length;
writeFileSync(CLOSURE, JSON.stringify(doc, null, 2) + "\n");

// ── 2. re-anchor the SW's CLOSURE_KAPPA to the (now consistent) os-closure.json ──────────────────────
const closureKappa = sha256hex(readFileSync(CLOSURE));
const swText = readFileSync(SW, "utf8");
const re = /const CLOSURE_KAPPA = "([0-9a-f]{64})";/;
const m = swText.match(re);
if (!m) fail("could not find the CLOSURE_KAPPA anchor in holo-fhs-sw.js");
const oldAnchor = m[1];
if (oldAnchor !== closureKappa) {
  writeFileSync(SW, swText.replace(re, `const CLOSURE_KAPPA = "${closureKappa}";`));
}

console.log(
  `✓ reseal-site: ${drifted} closure key(s) resealed · CLOSURE_KAPPA ${oldAnchor.slice(0, 12)}… → ${closureKappa.slice(0, 12)}… · ${Object.keys(closure).length} κ`,
);
