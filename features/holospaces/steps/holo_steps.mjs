// Step definitions for the Hermes-in-Holospaces feature suite.
// The runner (tools/holo/bdd.mjs) sets globalThis.__bdd BEFORE importing this file, so we read the
// DSL off the global rather than importing the runner (which would re-trigger its main()).
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const { Given, When, Then, And } = globalThis.__bdd;

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const read = (p) => readFileSync(p, "utf8");
const readJSON = (p) => JSON.parse(read(p));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const PENDING = (reason) => { throw new Error("PENDING: " + reason); };

// ── Stage A — the app object (real assertions, expected green) ───────────────────────────────────

Given("the os-holo frame is vendored at {string}", (w, dir) => {
  assert(existsSync(`${dir}/system/os/holo-fhs-sw.js`), `frame not vendored at ${dir} (no holo-fhs-sw.js)`);
  assert(existsSync(`${dir}/system/os/usr/lib/holo/holo-object.mjs`), `seal primitives missing under ${dir}`);
});

Given("the Hermes app is sealed", (w) => {
  assert(existsSync("apps/hermes/holospace.lock.json"), "apps/hermes/holospace.lock.json missing — run tools/holo/build-app.sh");
  w.lock = readJSON("apps/hermes/holospace.lock.json");
});

When("I re-seal the app with relock", (w) => {
  w.out = sh("FRAME=holo APPS=apps node tools/holo/relock.mjs hermes");
  w.lock = readJSON("apps/hermes/holospace.lock.json");
});

Then("the root κ equals {string}", (w, kappa) => {
  assert(w.lock.root === kappa, `root κ ${w.lock.root} ≠ ${kappa}`);
});

Then("re-sealing reports no changed files", (w) => {
  assert(/changed:\s*\n\s*\(none\)/.test(w.out), "re-seal reported changed files — seal is not deterministic:\n" + w.out);
});

Then("the lock identifier is {string}", (w, id) => {
  assert(w.lock.identifier === id, `identifier ${w.lock.identifier} ≠ ${id}`);
});

Then("the closure contains {string}", (w, key) => {
  assert(w.lock.closure[key], `closure missing ${key}`);
});

Then("the conscience gate {string} is pinned in the closure", (w, key) => {
  assert(w.lock.closure[key], `conscience gate ${key} not pinned`);
});

Then("every closure entry is dual-axis sha256 and blake3", (w) => {
  for (const [k, e] of Object.entries(w.lock.closure)) {
    assert(e.kappa?.startsWith("did:holo:sha256:"), `${k} missing sha256 kappa`);
    assert(e.alsoKnownAs?.[0]?.startsWith("did:holo:blake3:"), `${k} missing blake3 anchor`);
  }
});

Then("the lock carries an atlas coordinate", (w) => {
  assert(w.lock["holo:atlasCoordinate"] && w.lock["holo:within"], "missing holo:atlasCoordinate / holo:within");
});

Then("the built {string} has no leading-slash asset references", (w, file) => {
  const html = read(file);
  const abs = (html.match(/(?:src|href)="\/[^"]*"/g) || []).filter((s) => !/="\/\//.test(s));
  assert(abs.length === 0, `absolute asset refs present (break under iframe mount): ${abs.join(", ")}`);
});

Then("no WebSocket or raw fetch is constructed outside {string}", (w, allow) => {
  const isComment = (l) => { const body = l.replace(/^[^:]+:\d+:/, "").trim(); return body.startsWith("//") || body.startsWith("*"); };
  const sockets = sh(`grep -rn "new WebSocket\\|new EventSource" web/src || true`).split("\n").filter((l) => l && !l.includes(allow) && !isComment(l));
  assert(sockets.length === 0, "sockets constructed outside the seam:\n" + sockets.join("\n"));
  const fetches = sh(`grep -rn "[^.a-zA-Z]fetch(" web/src || true`)
    .split("\n")
    .filter((l) => l && !l.includes(allow) && !l.includes("authedFetch") && !l.includes("fetchJSON") && !l.includes("//") && !l.includes("* "));
  assert(fetches.length === 0, "raw fetch outside the seam:\n" + fetches.join("\n"));
});

// ── Stage A — registration / assembly ─────────────────────────────────────────────────────────

When("I assemble the site into {string}", (w, out) => {
  w.assembleOut = out;
  sh(`FRAME=holo APPS=apps OUT=${out} node tools/holo/assemble-site.mjs hermes`);
  w.witness = readJSON(`${out}/holo-witness-assemble.json`);
  w.osClosure = readJSON(`${out}/etc/os-closure.json`);
});

Then("the served root contains {string}", (w, rel) => {
  assert(existsSync(`${w.assembleOut}/${rel}`), `served root missing ${rel}`);
});

Then("os-closure lists app {string} with the sealed root κ", (w, id) => {
  const app = w.osClosure.apps.find((a) => a.identifier === id);
  assert(app, `os-closure apps[] missing ${id}`);
  assert(app.root === readJSON("apps/hermes/holospace.lock.json").root, `os-closure root ${app.root} ≠ sealed root`);
});

Then("the catalog lists app {string}", (w, id) => {
  assert(w.witness.checks["catalog lists app"], `catalog does not list ${id}`);
});

Then("at least {int} pre-existing frame apps are preserved", (w, n) => {
  // assembled apps[] = frame apps + Hermes; so frame apps preserved = total - 1.
  assert(w.osClosure.apps.length - 1 >= Number(n), `only ${w.osClosure.apps.length - 1} frame apps preserved (< ${n})`);
});

// ── Cross-cutting — the transport seam (real: the swap point exists today) ───────────────────────

Given("the api.ts transport seam", (w) => { w.api = read("web/src/lib/api.ts"); });

Then("it exports {string}", (w, sym) => {
  assert(new RegExp(`export (async )?function ${sym}\\b`).test(w.api), `api.ts does not export ${sym}`);
});

// ── HL-4 — the RISC-V loopback boot shim (carried in-repo as a patch) ───────────────────────────

Given("the holospaces-web loopback shim patch", (w) => {
  const p = "tools/holo/patches/holospaces-web-riscv-loopback.patch";
  assert(existsSync(p), `${p} missing`);
  w.patch = read(p);
});

Then("it adds the boot fn {string}", (w, fn) => {
  assert(new RegExp(`\\+\\s*pub fn ${fn}\\b`).test(w.patch), `patch does not add pub fn ${fn}`);
});

Then("it enables the loopback ingress bridge", (w) => {
  assert(/\+.*machine\.enable_loopback\(\)/.test(w.patch), "patch does not call machine.enable_loopback()");
});

Then("it composes routed egress with an OPFS-paged disk", (w) => {
  assert(/ChannelEgress::new\(\)/.test(w.patch), "patch missing routed egress (ChannelEgress)");
  assert(/OpfsKappaStore::new/.test(w.patch), "patch missing OPFS-paged disk (OpfsKappaStore)");
});

Then("it is modeled on the existing routed-OPFS-streamed boot path", (w) => {
  assert(/boot_net_streamed/.test(w.patch), "patch should reuse boot_net_streamed (the routed-OPFS-streamed path)");
});

// ── HL-5 — the transport bootstrap (origin / static / hologram selection) ───────────────────────

Given("the holo transport bootstrap", (w) => {
  assert(existsSync("web/src/lib/holo-bootstrap.ts"), "holo-bootstrap.ts missing");
  w.bootstrap = read("web/src/lib/holo-bootstrap.ts");
  assert(/export function selectHoloTransport\b/.test(w.bootstrap), "bootstrap does not export selectHoloTransport");
});

Then("it selects the {string} transport when {string} is present", (w, mode, signal) => {
  assert(w.bootstrap.includes(signal), `bootstrap missing signal ${signal}`);
  const installer = mode === "hologram" ? "installHologramTransport" : "installStaticTransport";
  assert(w.bootstrap.includes(installer), `bootstrap does not install ${installer} for ${mode}`);
});

Then("it defaults to the origin transport with no signal", (w) => {
  assert(/return "origin"/.test(w.bootstrap), "bootstrap does not default to origin");
});

Then("selectHoloTransport is wired into the app entry", () => {
  const main = read("web/src/main.tsx");
  assert(/selectHoloTransport\(\)/.test(main) && /holo-bootstrap/.test(main), "main.tsx does not call selectHoloTransport before render");
});

Then("the static transport answers reads with empty states and inert sockets", () => {
  const s = read("web/src/lib/holo-static-transport.ts");
  assert(/export function installStaticTransport\b/.test(s), "no installStaticTransport");
  assert(/setFetchImpl/.test(s) && /setSocketFactory/.test(s), "static transport does not install both halves");
  assert(/InertSocket/.test(s), "static transport has no inert socket");
});

Then("the holospace build defaults to the static shell when no guest bridge is present", (w) => {
  // The holospace build (base=./) is mounted with no co-located backend; without the static default it
  // would fall through to origin and 404 every /api call on the static host. The default must be gated on
  // the build flag (so the server build keeps origin) and install the static transport.
  assert(/__HERMES_HOLO_BUILD__/.test(w.bootstrap), "bootstrap missing the __HERMES_HOLO_BUILD__ static default → holospace Pages mount would 404 /api against origin");
  assert(/__HERMES_HOLO_BUILD__\b[\s\S]{0,160}installStaticTransport\(\)/.test(w.bootstrap), "the holospace-build branch does not install the static transport");
});

Then("the vite build wires the holospace-build flag", () => {
  const cfg = read("web/vite.config.ts");
  assert(/define\s*:/.test(cfg), "vite.config.ts has no define block");
  assert(/__HERMES_HOLO_BUILD__\s*:\s*JSON\.stringify\(\s*process\.env\.HERMES_HOLO_BASE\s*!=\s*null\s*\)/.test(cfg),
    "vite define does not set __HERMES_HOLO_BUILD__ from HERMES_HOLO_BASE (the holospace build marker)");
});

// ── Stages B / C / D — documented behaviors, pending external dependencies ───────────────────────
// These steps PASS for groundwork already in place and throw a precise PENDING for the parts that
// require an out-of-repo dependency (the riscv64 image/kernel, the holospaces-web boot shim, a relay).
// A @pending scenario is red-by-design; the PENDING reason is recorded in the witness.

Given("a linux/riscv64 OCI image carrying the Python Hermes runtime", () =>
  PENDING("build the linux/riscv64 OCI image (buildx) — Dockerfile retargeted to riscv64; not buildable in this sandbox"));

Given("a riscv64 Linux kernel image for the HGOS boot descriptor", () =>
  PENDING("provenance of the riscv64 kernel image κ (DTB is generated by the Boot Orchestrator)"));

When("the guest boots under the in-browser RISC-V emulator", () =>
  PENDING("boot via holospaces-web boot_devcontainer_routed_opfs_streamed; wasmi-interpreted, browser-only"));

Then("python run_agent.py --help returns inside the guest", () =>
  PENDING("requires the booted guest (Stage B)"));

Then("the dashboard reaches web_server.py over the loopback bridge", () =>
  PENDING("add the RISC-V routed_opfs+enable_loopback boot fn to holospaces-web (modeled on AArch64 boot_devcontainer_opfs_full), then register the hologram transport via setSocketFactory"));

Then("LLM egress leaves via relay or direct CORS fetch", () =>
  PENDING("Stage D egress: boot_devcontainer_net relay_url, or direct fetch under COEP credentialless; keys runtime-only"));

Then("a chat turn calls a tool, writes a session, and survives a tab reload", () =>
  PENDING("full-loop convergence across Stages B–D on the OPFS κ-store"));

// ── HL-6 — native convergence witness (GREEN once the on-demand boot has recorded its artifacts) ──
// These read the durable proof the cc_hermes_guest witness writes (vv/witness/hermes-guest-witness.json
// + hermes-resume-witness.json). Present locally after tools/holo/witness/run-hermes-guest.sh; absent in
// the CI gate (vv/witness is regenerated, not committed) → PENDING → RED, non-gating. Honest either way.
const NATIVE_WITNESS = "vv/witness/hermes-guest-witness.json";
const RESUME_WITNESS = "vv/witness/hermes-resume-witness.json";

Given("the linux/riscv64 Hermes OCI image is built", () => {
  if (!existsSync("vv/witness/hermes-riscv64-oci/index.json"))
    PENDING("build the riscv64 Hermes image: tools/holo/build-guest-image.sh");
});

Given("the native convergence witness has run", (w) => {
  if (!existsSync(NATIVE_WITNESS))
    PENDING("run the convergence witness: tools/holo/witness/run-hermes-guest.sh (boots the guest; ~24 min, on demand)");
  w.native = readJSON(NATIVE_WITNESS);
});

Then("the in-guest dashboard reached READY", (w) =>
  assert(w.native.dashboard_ready === true, `witness dashboard_ready=${w.native.dashboard_ready} (expected true)`));

Then("it served a non-empty /api/status over the loopback bridge", (w) =>
  assert(Number(w.native.api_status_response_len) > 0,
    `witness api_status_response_len=${w.native.api_status_response_len} (expected > 0)`));

Then("the warm machine round-trips to the same content-address κ", (w) => {
  assert(w.native.round_trip_identical === true, "witness round_trip_identical != true");
  assert(w.native.warm_kappa && w.native.warm_kappa === w.native.resumed_kappa,
    `warm κ ${w.native.warm_kappa} ≠ resumed κ ${w.native.resumed_kappa}`);
});

Then("the banked κ resumes in a fresh process to a byte-identical machine with no re-boot", () => {
  if (!existsSync(RESUME_WITNESS))
    PENDING("run the resume test: cargo test … the_warm_dashboard_resumes_from_its_banked_kappa_byte_identical");
  const r = readJSON(RESUME_WITNESS);
  assert(r.byte_identical === true, "resume witness byte_identical != true");
  assert(r.booted === false, "resume witness booted != false (it must NOT re-boot)");
});
