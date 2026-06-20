#!/usr/bin/env node
// assemble-site.mjs — assemble the GitHub Pages _site: the vendored os-holo FHS image (the served
// root, with its content-verify Service Worker) with the sealed Hermes app FOLDED IN.
//
// The upstream staging tools (system/tools/{copy-content,compute-manifest,gen-apps-catalog,
// bundle-sdk-shell}.mjs) are hard-coded to the author's local desktop paths and are not reusable, so
// this reproduces their LOGIC, parameterized for this fork and ADDITIVE (it appends Hermes to the
// frame's existing 32 apps; it never regenerates from scratch, which would drop them):
//
//   1. copy the frame's served image  holo/system/os/*  →  _site/         (Law L1: served root)
//   2. place the app bytes  apps/hermes/<f>  →  _site/usr/share/holospaces/hermes/<f>
//      (the FHS map: flat apps/<id>/* → usr/share/holospaces/<id>/*), plus the app's lock
//   3. fold the app closure (apps/hermes/* + the pinned _shared gate) into _site/etc/os-closure.json
//      `closure`, and add {identifier, root} to `apps[]`  (the SW's BYPATH κ source, Law L5)
//   4. append the Hermes entry to the apps catalog  _site/usr/share/holospaces/index.jsonld
//      (served as apps/index.jsonld; dcat:landingPage the launcher mounts)
//   5. assert structure (a fail-closed witness) and write _site/holo-witness-assemble.json
//
// Idempotent. Re-run after build-app.sh.
//
//   FRAME=holo APPS=apps OUT=_site node tools/holo/assemble-site.mjs hermes

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const APP = process.argv[2] || "hermes";
const FRAME = process.env.FRAME ?? "holo";
const APPS = process.env.APPS ?? "apps";
const OUT = process.env.OUT ?? "_site";
const OS_SRC = join(FRAME, "system/os");
const APP_DIR = join(APPS, APP);

const fail = (m) => { console.error("✗ assemble-site: " + m); process.exit(1); };
if (!existsSync(join(OS_SRC, "holo-fhs-sw.js"))) fail(`frame not vendored at ${OS_SRC} (no holo-fhs-sw.js) — run: git submodule update --init`);
if (!existsSync(join(APP_DIR, "holospace.lock.json"))) fail(`app not sealed (${APP_DIR}/holospace.lock.json missing) — run: tools/holo/build-app.sh`);

const lock = JSON.parse(readFileSync(join(APP_DIR, "holospace.lock.json"), "utf8"));
const def = JSON.parse(readFileSync(join(APP_DIR, "holospace.json"), "utf8"));

// ── 1. served image ──────────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(OS_SRC, OUT, { recursive: true });

// ── 2. place app bytes under the FHS path the flat apps/<id>/* URL maps to ─────────────────────
let placed = 0;
for (const rel of Object.keys(lock.closure)) {
  if (!rel.startsWith(`apps/${APP}/`)) continue;          // _shared/* is the frame's, already present
  const sub = rel.slice(`apps/${APP}/`.length);
  const src = join(APP_DIR, sub);
  const dst = join(OUT, "usr/share/holospaces", APP, sub);
  if (!existsSync(src)) fail(`closure names ${rel} but ${src} is absent — reseal`);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  placed++;
}
// the app's lock travels with it: the SW loads apps/<id>/holospace.lock.json (serve-rel keys).
cpSync(join(APP_DIR, "holospace.lock.json"), join(OUT, "usr/share/holospaces", APP, "holospace.lock.json"));

// ── 3. fold the app closure + apps[] into the frame's os-closure.json (additive) ───────────────
const closurePath = join(OUT, "etc/os-closure.json");
const doc = JSON.parse(readFileSync(closurePath, "utf8"));
doc.closure = doc.closure || {};
doc.apps = doc.apps || [];
let folded = 0;
for (const [rel, entry] of Object.entries(lock.closure)) {
  // Frame already pins _shared/holo-conscience.js; identical κ → idempotent. App keys are added.
  if (!doc.closure[rel]) folded++;
  doc.closure[rel] = entry;
}
const appsEntry = { identifier: def.id, root: lock.root };
const ai = doc.apps.findIndex((a) => a.identifier === def.id);
if (ai >= 0) doc.apps[ai] = appsEntry; else doc.apps.push(appsEntry);
doc.files = Object.keys(doc.closure).length;
writeFileSync(closurePath, JSON.stringify(doc, null, 2) + "\n");

// ── 4. append the Hermes entry to the apps catalog (additive) ──────────────────────────────────
const catPath = join(OUT, "usr/share/holospaces/index.jsonld");
const cat = JSON.parse(readFileSync(catPath, "utf8"));
const dsKey = Array.isArray(cat["dcat:dataset"]) ? "dcat:dataset"
  : Array.isArray(cat["@graph"]) ? "@graph"
  : Object.keys(cat).find((k) => Array.isArray(cat[k]));
if (!dsKey) fail(`catalog ${catPath} has no dataset array`);
const kappa = appsEntry.root; // pinned now, so the catalog κ == the os-closure app root (Law L1)
const catalogEntry = {
  "@id": kappa,
  "@type": def.type || ["schema:SoftwareApplication", "schema:WebApplication"],
  "schema:name": def.name,
  "schema:identifier": def.id,
  "schema:description": def.summary || "",
  "schema:applicationCategory": def.applicationCategory || "Utility",
  "dcat:landingPage": `apps/${APP}/${def.entry || "index.html"}`,
  ...(def.icon ? { "schema:image": `apps/${APP}/${def.icon}` } : {}),
  ...(Array.isArray(def.shared) && def.shared.length ? { "schema:softwareRequirements": def.shared } : {}),
};
const ci = cat[dsKey].findIndex((e) => e["schema:identifier"] === def.id || e["@id"] === kappa);
if (ci >= 0) cat[dsKey][ci] = catalogEntry; else cat[dsKey].push(catalogEntry);
writeFileSync(catPath, JSON.stringify(cat, null, 2) + "\n");

// ── 5. fail-closed structural witness ──────────────────────────────────────────────────────────
const checks = {
  "served SW present": existsSync(join(OUT, "holo-fhs-sw.js")),
  "launcher present": existsSync(join(OUT, "usr/share/frame/holospace.html")),
  "app entry served": existsSync(join(OUT, "usr/share/holospaces", APP, def.entry || "index.html")),
  "app lock served": existsSync(join(OUT, "usr/share/holospaces", APP, "holospace.lock.json")),
  "os-closure has app root": doc.apps.some((a) => a.identifier === def.id && a.root === lock.root),
  "os-closure has entry κ": doc.closure[`apps/${APP}/${def.entry || "index.html"}`]?.kappa === lock.closure[`apps/${APP}/${def.entry || "index.html"}`]?.kappa,
  "conscience gate pinned": !!doc.closure["_shared/holo-conscience.js"],
  "catalog lists app": cat[dsKey].some((e) => e["schema:identifier"] === def.id),
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
const witness = {
  tool: "assemble-site", app: def.id, root: lock.root,
  servedRoot: OUT, appFilesPlaced: placed, closureFolded: folded,
  osClosureApps: doc.apps.length, osClosureFiles: doc.files,
  catalogApps: cat[dsKey].length, checks, ok: failed.length === 0,
};
writeFileSync(join(OUT, "holo-witness-assemble.json"), JSON.stringify(witness, null, 2) + "\n");
console.log(JSON.stringify(witness, null, 2));
if (failed.length) fail("witness failed: " + failed.join(", "));
console.log(`✓ assemble-site: ${OUT} ready — ${placed} app files, ${doc.apps.length} apps, ${doc.files} closure κ`);
