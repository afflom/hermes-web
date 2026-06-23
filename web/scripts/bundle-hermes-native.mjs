// Build step: bundle the REAL Hermes Python (the whole agent, not a subset) + a dep manifest derived from
// pyproject.toml, for the native-exec backend to load under Pyodide. DRY: the deployed code IS the repo's
// Python (no fork); deps come from pyproject (single source of truth). Emits to web/public/native/.
//
//   node web/scripts/bundle-hermes-native.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "web/public/native");
mkdirSync(OUT, { recursive: true });

// The Hermes Python source = the WHOLE repo's Python (parametric over the FULL agent), minus the JS app, tests,
// scratch, and build dirs. We don't hand-pick packages (that missed tools/toolsets); we include every top-level
// package + root module and let the .py filter below keep it to source.
const EXCLUDE = new Set([
  "web", "e2e", "spike", "vv", "node_modules", "docs", ".git", ".github", ".devcontainer", ".vscode",
  "dist", "build", "__pycache__", ".pytest_cache", ".ruff_cache", ".venv", "tests", "test",
]);
const SRC = readdirSync(REPO, { withFileTypes: true })
  .filter((e) => !EXCLUDE.has(e.name) && !e.name.startsWith("."))
  .filter((e) => e.isDirectory() || e.name.endsWith(".py"))
  .map((e) => e.name);

// Tar ONLY the Python (.py) — the import surface — never the packages' large data/asset trees (apps/ etc.).
// One content artifact the runtime unpacks into Pyodide FS. (Runtime-needed package data is added explicitly
// if a gate surfaces it; keeping the bundle to source keeps it MBs, not hundreds.)
const TAR = path.join(OUT, "hermes-src.tar");
const found = execFileSync("bash", ["-c",
  `cd ${JSON.stringify(REPO)} && find ${SRC.map((s) => `'${s}'`).join(" ")} -name '*.py' -not -path '*/__pycache__/*'`,
]).toString();
const listFile = path.join(os.tmpdir(), `hermes-src-${process.pid}.list`);
writeFileSync(listFile, found);
try {
  execFileSync("tar", ["--format=ustar", "-cf", TAR, "-C", REPO, "-T", listFile]);
} finally {
  rmSync(listFile, { force: true });
}

// Dep manifest from pyproject [project].dependencies — the REQUIRED runtime set (provider-optional deps install
// lazily at runtime when configured, so the base bundle stays small). The runtime decides loadPackage vs micropip.
const pyproject = readFileSync(path.join(REPO, "pyproject.toml"), "utf8");
const depBlock = pyproject.match(/^dependencies\s*=\s*\[(.*?)^\]/ms)?.[1] ?? "";
// Binary wheels Pyodide ships ABI-matched — load from its bundle, never micropip (a mismatched wasm wheel
// aborts). These are excluded from the micropip `required` list so their pinned version doesn't conflict with
// the already-installed bundled one.
const LOAD_PACKAGE = ["pydantic", "pyyaml"];
const required = [...depBlock.matchAll(/"([A-Za-z0-9_.\-]+)(\[[^\]]*\])?\s*([<>=!~]=?[^"]*)?"/g)]
  .map((m) => ({ name: m[1], extras: m[2] ?? "", spec: (m[3] ?? "").trim() }))
  .filter((d) => d.name.toLowerCase() !== "uvicorn") // ASGI is driven in-process; no server in-browser
  .filter((d) => !LOAD_PACKAGE.includes(d.name.toLowerCase())) // handled by loadPackage, not micropip
  // Process/terminal libs have no in-browser backing → the holospace surface provides them (G5); excluding
  // them from the base bundle lets Hermes's `except ImportError` guards degrade the agent's PTY cleanly.
  .filter((d) => !["psutil", "ptyprocess", "winpty", "pywinpty"].includes(d.name.toLowerCase()));

const manifest = {
  pyodide: "0.28.3",
  loadPackage: [...LOAD_PACKAGE, "micropip"],
  required: required.map((d) => `${d.name}${d.extras}${d.spec}`),
  // OS modules with no in-browser backing — the os_surface adapter stubs/routes these (DRY, one place).
  osSurface: ["psutil", "fcntl", "termios", "resource", "grp", "pwd"],
};
writeFileSync(path.join(OUT, "deps.json"), JSON.stringify(manifest, null, 2) + "\n");

// Ship the OS-surface adapter alongside (the worker fetches it; the gate reads it from src) — ONE source file.
execFileSync("cp", [path.join(REPO, "web/src/native/os_surface.py"), path.join(OUT, "os_surface.py")]);

const mb = (p) => (statSync(p).size / 1e6).toFixed(1);
console.log(`[bundle] hermes-src.tar: ${mb(TAR)} MB (${SRC.length} source roots)`);
console.log(`[bundle] deps.json: ${manifest.required.length} required deps, pyodide ${manifest.pyodide}`);
