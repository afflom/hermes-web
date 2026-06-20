#!/usr/bin/env node
// bdd.mjs — a dependency-free, strict Gherkin runner + witness emitter for the Hermes-in-Holospaces
// lift. Documentation-as-code: the .feature files ARE the executable spec; this runs them against the
// real artifacts (the seal, the assembled _site, the source tree) and emits an os-holo-style witness.
//
//   node tools/holo/bdd.mjs [featureDir=features/holospaces] [--witness path] [--tags @stage-a]
//
// Strictness contract:
//   • An UNDEFINED or FAILING step in a normal scenario FAILS the suite (exit 1).
//   • A scenario tagged @pending is red-by-design (a documented behavior not yet wired): its
//     undefined/failing steps are recorded as PENDING and do NOT fail the suite. If a @pending
//     scenario UNEXPECTEDLY PASSES end-to-end, that is itself a failure (un-pend it) — pending must
//     stay honest, never a silent green.
//
// Supported Gherkin subset: Feature, Background, Scenario, Scenario Outline + Examples, tags,
// Given/When/Then/And/But, # comments. (No doc-strings / data-tables — unused here.)

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";

// ── args ───────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let featureDir = "features/holospaces";
let witnessPath = "tools/holo/witness/bdd.json";
let tagFilter = null;
let skipTag = null;
let targetsMode = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--witness") witnessPath = argv[++i];
  else if (argv[i] === "--tags") tagFilter = argv[++i];
  else if (argv[i] === "--skip-tags") skipTag = argv[++i];
  else if (argv[i] === "--targets") targetsMode = true; // V&V targets tier: run @pending scenarios STRICT (expected-RED until met)
  else if (!argv[i].startsWith("--")) featureDir = argv[i];
}

// ── step registry ────────────────────────────────────────────────────────────────────────────
const steps = [];
const toRegex = (pat) => {
  if (pat instanceof RegExp) return pat;
  // Cucumber-lite expressions: {string} {word} {int}, else literal (regex-escaped).
  const src = pat
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => (["{", "}"].includes(m) ? m : "\\" + m))
    .replace(/\\\{string\\\}/g, '"((?:[^"\\\\]|\\\\.)*)"')
    .replace(/\\\{word\\\}/g, "(\\S+)")
    .replace(/\\\{int\\\}/g, "(\\d+)")
    .replace(/\{string\}/g, '"((?:[^"\\\\]|\\\\.)*)"')
    .replace(/\{word\}/g, "(\\S+)")
    .replace(/\{int\}/g, "(\\d+)");
  return new RegExp("^" + src + "$");
};
const def = (kw) => (pat, fn) => steps.push({ kw, re: toRegex(pat), fn });
export const Given = def("step"), When = def("step"), Then = def("step"), And = def("step");
globalThis.__bdd = { Given, When, Then, And, But: And };

// ── parser ──────────────────────────────────────────────────────────────────────────────────────
function parseFeature(text, file) {
  const lines = text.split(/\r?\n/);
  const feat = { file, name: "", tags: [], background: [], scenarios: [] };
  let pendingTags = [], cur = null, mode = null, outline = null;
  const stepKw = /^(Given|When|Then|And|But)\s+(.*)$/;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("@")) { pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith("@"))); continue; }
    let m;
    if ((m = line.match(/^Feature:\s*(.*)$/))) { feat.name = m[1]; feat.tags = pendingTags; pendingTags = []; cur = null; mode = null; }
    else if (line.match(/^Background:/)) { mode = "background"; cur = null; }
    else if ((m = line.match(/^Scenario Outline:\s*(.*)$/))) { cur = { name: m[1], tags: pendingTags, steps: [], examples: [] }; outline = cur; mode = "scenario"; feat.scenarios.push(cur); pendingTags = []; }
    else if ((m = line.match(/^Scenario:\s*(.*)$/))) { cur = { name: m[1], tags: pendingTags, steps: [] }; outline = null; mode = "scenario"; feat.scenarios.push(cur); pendingTags = []; }
    else if (line.match(/^Examples:/)) { mode = "examples"; }
    else if (mode === "examples" && line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (!outline.__head) outline.__head = cells; else outline.examples.push(cells);
    }
    else if ((m = line.match(stepKw))) {
      const step = { kw: m[1], text: m[2] };
      if (mode === "background") feat.background.push(step);
      else if (cur) cur.steps.push(step);
    }
  }
  return feat;
}

// ── expand Scenario Outline → concrete scenarios ────────────────────────────────────────────────
function expand(feat) {
  const out = [];
  for (const sc of feat.scenarios) {
    if (sc.__head && sc.examples.length) {
      for (const row of sc.examples) {
        const subst = (s) => s.replace(/<([^>]+)>/g, (_, k) => { const i = sc.__head.indexOf(k); return i >= 0 ? row[i] : `<${k}>`; });
        out.push({ name: sc.name + " [" + row.join(",") + "]", tags: sc.tags, steps: sc.steps.map((st) => ({ kw: st.kw, text: subst(st.text) })) });
      }
    } else out.push(sc);
  }
  return out;
}

// ── runner ──────────────────────────────────────────────────────────────────────────────────────
const unescape = (a) => (typeof a === "string" ? a.replace(/\\(["\\])/g, "$1") : a);
function matchStep(text) {
  for (const s of steps) { const m = text.match(s.re); if (m) return { fn: s.fn, args: m.slice(1).map(unescape) }; }
  return null;
}

async function runScenario(feat, sc) {
  // In --targets mode the pending leniency is OFF: a @pending scenario runs strict, so its
  // PENDING-throwing steps FAIL it (RED) until the component is built, and it goes green (MET) when
  // the capability lands — mirroring holospaces' vv/targets/ tier (expected-RED, then promote).
  const isPending = !targetsMode && (sc.tags.includes("@pending") || feat.tags.includes("@pending"));
  const world = {};
  const results = [];
  let scenarioOk = true, sawUndefinedOrFail = false;
  for (const st of [...feat.background, ...sc.steps]) {
    const match = matchStep(st.text);
    if (!match) { results.push({ step: `${st.kw} ${st.text}`, status: "undefined" }); sawUndefinedOrFail = true; scenarioOk = false; if (!isPending) break; continue; }
    try {
      await match.fn(world, ...match.args);
      results.push({ step: `${st.kw} ${st.text}`, status: "passed" });
    } catch (e) {
      results.push({ step: `${st.kw} ${st.text}`, status: "failed", error: String(e && e.message || e) });
      sawUndefinedOrFail = true; scenarioOk = false; if (!isPending) break;
    }
  }
  // status: pending scenarios are red-by-design; an all-green pending is a contract violation.
  let status;
  if (isPending) status = sawUndefinedOrFail ? "pending" : "pending-unexpectedly-green";
  else status = scenarioOk ? "passed" : "failed";
  return { name: sc.name, tags: sc.tags, pending: isPending, status, steps: results };
}

async function main() {
  // featureDir may be a directory OR a single .feature file (one V&V suite/target per file).
  const isFile = (() => { try { return statSync(featureDir).isFile(); } catch { return false; } })();
  const baseDir = isFile ? dirname(featureDir) : featureDir;

  // load step definitions (always from the <baseDir>/steps directory)
  const stepsDir = join(baseDir, "steps");
  let stepFiles = [];
  try { stepFiles = readdirSync(stepsDir).filter((f) => extname(f) === ".mjs").map((f) => join(stepsDir, f)); } catch { /* none */ }
  for (const f of stepFiles) await import(pathToFileURL(f).href + "?t=" + stepFiles.indexOf(f));

  // load features
  const featFiles = isFile
    ? [featureDir]
    : readdirSync(featureDir).filter((f) => extname(f) === ".feature").map((f) => join(featureDir, f)).sort();
  const report = { featureDir, features: [], totals: { passed: 0, failed: 0, pending: 0, scenarios: 0 } };
  for (const ff of featFiles) {
    const feat = parseFeature(readFileSync(ff, "utf8"), ff);
    const hasTag = (sc, t) => sc.tags.includes(t) || feat.tags.includes(t);
    const scenarios = expand(feat).filter((sc) =>
      (!tagFilter || hasTag(sc, tagFilter)) && (!skipTag || !hasTag(sc, skipTag)));
    const fr = { feature: feat.name, file: ff, scenarios: [] };
    for (const sc of scenarios) {
      const r = await runScenario(feat, sc);
      fr.scenarios.push(r);
      report.totals.scenarios++;
      if (r.status === "passed") report.totals.passed++;
      else if (r.status === "pending") report.totals.pending++;
      else report.totals.failed++;
    }
    report.features.push(fr);
  }

  // print
  const ICON = { passed: "✓", failed: "✗", pending: "○", "pending-unexpectedly-green": "‼" };
  for (const fr of report.features) {
    console.log(`\nFeature: ${fr.feature}  (${fr.file})`);
    for (const sc of fr.scenarios) {
      console.log(`  ${ICON[sc.status] || "?"} ${sc.status.toUpperCase().padEnd(8)} ${sc.name}`);
      for (const st of sc.steps) if (st.status !== "passed") console.log(`      ${st.status === "failed" ? "✗" : "○"} ${st.step}${st.error ? "  — " + st.error : ""}`);
    }
  }
  const t = report.totals;
  console.log(`\n${t.passed} passed · ${t.pending} pending · ${t.failed} failed  (${t.scenarios} scenarios)`);

  mkdirSync(dirname(witnessPath), { recursive: true });
  report.ok = t.failed === 0;
  writeFileSync(witnessPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`witness → ${witnessPath}`);
  process.exit(t.failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
