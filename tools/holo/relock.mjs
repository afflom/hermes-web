#!/usr/bin/env node
// relock.mjs — seal apps/<id>/holospace.lock.json against the vendored os-holo κ primitives.
//
// Mirrors os-holo's system/tools/relock-app.local.mjs closure/links/root logic byte-for-byte; only the
// three path constants are repointed at THIS repo's layout. The root identity is computed by the
// upstream makeObject (canonical object hash), never reimplemented — so the lock re-derives
// identically to an upstream seal.
//
//   FRAME=holo APPS=apps node tools/holo/relock.mjs hermes
//
//   FRAME  path to the vendored os-holo checkout (default: holo)
//   APPS   directory holding apps/<id>/        (default: apps)

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.argv[2];
if (!APP) { console.error("usage: node tools/holo/relock.mjs <app-id>"); process.exit(2); }

const FRAME = process.env.FRAME ?? "holo";
const APPS  = process.env.APPS  ?? "apps";
const RT      = join(FRAME, "system/os/usr/lib/holo"); // primitives + _shared runtime
const SHARED  = RT;
const APP_DIR = join(APPS, APP);

const { sha256hex, sriOf, mbSha256 } = await import(pathToFileURL(join(RT, "holo-uor.mjs")));
const { makeObject, contentLink }    = await import(pathToFileURL(join(RT, "holo-object.mjs")));
const { blake3hex }                  = await import(pathToFileURL(join(SHARED, "holo-blake3.mjs")));
const { atlasCoord, ATLAS }          = await import(pathToFileURL(join(SHARED, "holo-atlas-coord.mjs")));

// TYPE must match os-holo's relock-app exactly: the per-link @type is hashed into the
// root via contentLink, so any divergence (e.g. mapping .webp/.ico) changes the app's κ.
const TYPE = { ".html": "schema:WebPage", ".js": "schema:SoftwareSourceCode", ".mjs": "schema:SoftwareSourceCode",
  ".css": "schema:SoftwareSourceCode", ".json": "schema:Dataset", ".jsonld": "schema:Dataset", ".hc": "schema:SoftwareSourceCode",
  ".svg": "schema:ImageObject", ".png": "schema:ImageObject", ".wasm": "schema:SoftwareApplication" };
const typeOf = (p) => TYPE[extname(p).toLowerCase()] || "schema:MediaObject";
const walk = (dir, out = []) => { for (const n of readdirSync(dir).sort()) { const p = join(dir, n);
  statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };

const def  = JSON.parse(readFileSync(join(APP_DIR, "holospace.json"), "utf8"));
const prev = existsSync(join(APP_DIR, "holospace.lock.json")) ? JSON.parse(readFileSync(join(APP_DIR, "holospace.lock.json"), "utf8")) : { closure: {} };
const closure = {}, links = [];
const add = (abs, rel) => {
  if (closure[rel]) return;
  const bytes = readFileSync(abs), hex = sha256hex(bytes);
  closure[rel] = { kappa: `did:holo:sha256:${hex}`, sri: sriOf(bytes), multibase: mbSha256(bytes), bytes: bytes.length, alsoKnownAs: [`did:holo:blake3:${blake3hex(bytes)}`] };
  links.push({ ...contentLink("schema:hasPart", `sha256:${hex}`, typeOf(rel)), "schema:name": rel });
};

for (const p of walk(APP_DIR)) if (basename(p) !== "holospace.lock.json")
  add(p, `apps/${APP}/` + relative(APP_DIR, p).split("\\").join("/"));
for (const dep of def.shared || []) {
  const d = dep.replace(/\/$/, ""), dp = join(SHARED, d);
  if (existsSync(dp)) {
    if (statSync(dp).isDirectory()) { for (const f of walk(dp)) add(f, "_shared/" + relative(SHARED, f).split("\\").join("/")); }
    else add(dp, `_shared/${d}`);
  } else if (existsSync(join(APP_DIR, d))) {
    continue; // app-vendored bundle, already walked + hashed under apps/<id>/
  } else {
    throw new Error(`missing shared dep (neither OS _shared nor app-local): ${dep}`);
  }
}
const gate = join(SHARED, "holo-conscience.js");
if (existsSync(gate)) add(gate, "_shared/holo-conscience.js");
links.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const root = makeObject(new Map(), {
  type: [...(def.type || ["schema:SoftwareApplication"]), "prov:Entity"],
  context: [{ hosc: "https://hologram.os/ns/conformance#" }],
  "schema:name": def.name,
  ...(def.summary ? { "schema:description": def.summary } : {}),
  ...(def.applicationCategory ? { "schema:applicationCategory": def.applicationCategory } : {}),
  "schema:identifier": def.id,
  ...(def.conforms?.specs ? { "schema:featureList": def.conforms.specs } : {}),
  ...(def.capabilities ? { "hosc:capabilities": def.capabilities } : {}),
  "prov:wasGeneratedBy": { "@id": "https://hologram.os/tools/build-app" },
  links,
});

const changed = [];
for (const rel of new Set([...Object.keys(prev.closure || {}), ...Object.keys(closure)])) {
  const a = prev.closure?.[rel]?.kappa, b = closure[rel]?.kappa;
  if (a !== b) changed.push(`${a ? (b ? "~" : "-") : "+"} ${rel}`);
}
console.log(`root ${prev.root} → ${root.id}`);
console.log(`files ${Object.keys(prev.closure || {}).length} → ${Object.keys(closure).length}`);
console.log("changed:\n  " + (changed.length ? changed.join("\n  ") : "(none)"));

const lock = { "@context": { dcterms: "http://purl.org/dc/terms/", holo: "https://hologram.os/ns#" },
  root: root.id, identifier: def.id, algo: "sha256",
  "holo:within": ATLAS.object, "holo:atlasCoordinate": atlasCoord(root.id),
  files: Object.keys(closure).length, closure };
writeFileSync(join(APP_DIR, "holospace.lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log(`✓ wrote ${APP_DIR}/holospace.lock.json`);
