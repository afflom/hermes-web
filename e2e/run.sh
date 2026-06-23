#!/usr/bin/env bash
# e2e/run.sh — the ONE supported way to run the browser e2e gate locally.
#
# WHY THIS EXISTS
#   Each warm-κ test loads a 1.44 GB machine into the page, builds a ~1.4 GB wasm heap, and drives a real
#   Chromium. Two runs at once spike past what the kernel can reclaim, so the OOM killer SIGKILLs chromium
#   at launch — no log is written, so it looks like a mysterious startup hang. Killed runs also orphan
#   chromium children that pile up and starve the next launch. This harness removes both failure modes:
#     • an flock so only ONE e2e run can exist at a time (no concurrent memory spikes),
#     • a reaper that targets ONLY Playwright's chromium (its ms-playwright binary path) and this suite's
#       own static server — it never matches `node` broadly, so claude-code / vscode-server are safe,
#     • a trap so cleanup always runs, even on Ctrl-C or timeout,
#     • a tee'd, timestamped log you can read while it runs.
#
# USAGE
#   e2e/run.sh                          # full suite against a local web/dist-pages build
#   e2e/run.sh -g "backend"             # only tests whose title matches the grep
#   BUILD=1 e2e/run.sh [args]           # vite-build web/dist-pages first, then run
#   E2E_BASE_URL=https://afflom.github.io/hermes-web/ e2e/run.sh   # run against the live site
#   E2E_TIMEOUT=900 e2e/run.sh          # override the wall-clock cap (default 600s)
#   e2e/run.sh doctor                   # just reap stray chromium + print env health, run nothing
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E_DIR/.." && pwd)"
LOGDIR="$ROOT/vv/witness"; mkdir -p "$LOGDIR"
LOCK="/tmp/hermes-e2e.lock"
# The Playwright browser cache path is unique to chromium processes; it never appears in the cmdline of
# the node test-runner, claude-code, or vscode-server — so matching it is safe and precise.
PW_PATH="$HOME/.cache/ms-playwright"

reap_chromium() {
  pkill -9 -f "$PW_PATH" 2>/dev/null || true        # every chromium proc (browser/renderer/gpu/crashpad)
  pkill -9 -f "$E2E_DIR/serve.mjs" 2>/dev/null || true  # this suite's static server (full path → precise)
  return 0
}

# Cap accumulated run logs so vv/witness scratch stays bounded across the many boots a long session does —
# otherwise per-run e2e-*.log / browser-console-*.log pile up unbounded and slowly fill the devcontainer disk.
KEEP_LOGS="${E2E_KEEP_LOGS:-20}"
prune_logs() {
  local keep="${1:-$KEEP_LOGS}"
  ls -t "$LOGDIR"/e2e-*.log 2>/dev/null             | tail -n +$((keep+1)) | xargs -r rm -f
  ls -t "$LOGDIR"/browser-console-*.log 2>/dev/null | tail -n +$((keep+1)) | xargs -r rm -f
}

health() {
  echo "=== e2e env health ==="
  local n; n="$(pgrep -fc "$PW_PATH" 2>/dev/null)"; n="${n:-0}"
  echo "stray chromium procs : $n$([ "$n" -gt 0 ] && echo '   ← DEGRADED: run `e2e/run.sh doctor`')"
  free -m | awk '/Mem:/{printf "RAM                  : %d MB avail / %d MB total\n",$7,$2}'
  df -h "$ROOT" 2>/dev/null | awk 'NR==2{u=$5+0;printf "disk                 : %s used of %s (%s)%s\n",$3,$2,$5,(u>=85?"   ← DEGRADED: run `e2e/run.sh clean`":"")}'
  local sc; sc="$(du -sh "$LOGDIR" 2>/dev/null | cut -f1)"
  local nlog; nlog="$(ls "$LOGDIR"/*.log 2>/dev/null | wc -l | tr -d ' ')"
  echo "witness scratch      : ${sc:-0} (${nlog:-0} run logs)"
  du -ah "$LOGDIR" 2>/dev/null | awk '$1 ~ /[0-9]G$/ {print "  reclaimable        : "$0}' | sort -rh | head -6
  if [ -f "$LOCK" ] && fuser "$LOCK" >/dev/null 2>&1; then
    echo "lock                 : HELD (an e2e run is active)"
  else
    echo "lock                 : free"
  fi
}

if [ "${1:-}" = "doctor" ]; then
  reap_chromium; prune_logs; rm -rf /tmp/playwright-artifacts-* 2>/dev/null || true; sleep 1; health
  echo "[doctor] reaped stray chromium, pruned old logs; env ready."
  exit 0
fi

# `e2e/run.sh clean` — deeper reclaim for a tight devcontainer disk: reap, keep only the last few logs, clear
# /tmp artifacts, and REPORT (never auto-delete) the large regenerable κ/image artifacts so reclaiming them is
# a deliberate choice (re-bank ~40 min, re-build image ~1 h).
if [ "${1:-}" = "clean" ]; then
  reap_chromium; prune_logs 5; rm -rf /tmp/playwright-artifacts-* 2>/dev/null || true
  echo "[clean] reaped chromium, kept last 5 run logs, cleared /tmp playwright artifacts."
  echo "[clean] large regenerable artifacts left in place (delete by hand only if disk is tight):"
  du -ah "$LOGDIR" 2>/dev/null | awk '$1 ~ /[0-9]G$|[0-9]{3}M$/ {print "  "$0}' | sort -rh | head -8
  health
  exit 0
fi

cleanup() { local ec=$?; reap_chromium; echo "[run] cleaned up chromium (exit $ec)"; }
trap cleanup EXIT INT TERM

# ---- single-run lock: refuse to start a second run rather than spike memory and SIGKILL both ----
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[run] another e2e run holds $LOCK — refusing to start a second (that spike is what SIGKILLs chromium)."
  echo "[run]   active? pgrep -af '$PW_PATH'      stale lock? rm -f $LOCK"
  exit 3
fi

cd "$E2E_DIR"
reap_chromium                 # clear orphans left by any previously-killed run
prune_logs                    # keep the last $KEEP_LOGS run logs so scratch never grows unbounded
sleep 1

LOG="$LOGDIR/e2e-$(date +%Y%m%d-%H%M%S).log"
if [ "${BUILD:-0}" = "1" ]; then
  # EXACTLY the deploy/CI build (.github/workflows/pages.yml). HERMES_HOLO_BASE is load-bearing: it both
  # sets base=/hermes-web/ AND flips the __HERMES_HOLO_BUILD__ define true (vite.config.ts) → the app
  # picks the `hologram` transport and mounts HologramBoot. A plain `vite build --base` leaves the define
  # false → `origin` mode → the in-browser worker NEVER boots and the backend test silently times out.
  echo "[run] vite build (hologram, HERMES_HOLO_BASE) → web/dist-pages"
  if ! ( cd "$ROOT/web" && HERMES_HOLO_BASE=/hermes-web/ npx vite build --outDir dist-pages --emptyOutDir ) >>"$LOG" 2>&1; then
    echo "[run] build FAILED — see $LOG"; exit 1
  fi
  cp "$ROOT/web/dist-pages/index.html" "$ROOT/web/dist-pages/404.html"   # SPA fallback, as the gate does
fi

free -m | awk '/Mem:/{printf "[run] RAM avail %d MB before launch\n",$7}'
echo "[run] log → $LOG"
echo "[run] playwright test $*"

CONSOLE_LOG="$LOGDIR/browser-console-$(date +%Y%m%d-%H%M%S).log"
: >"$CONSOLE_LOG"
TIMEOUT="${E2E_TIMEOUT:-600}"
# E2E_CONSOLE_LOG → the spec mirrors the in-browser console here, reliably, independent of the reporter.
E2E_CONSOLE_LOG="$CONSOLE_LOG" timeout --kill-after=20 "$TIMEOUT" npx playwright test "$@" 2>&1 | tee "$LOG"
EC=${PIPESTATUS[0]}

echo "[run] ---- browser console (in-guest boot/auth diagnostic) ----"
if [ -s "$CONSOLE_LOG" ]; then tail -60 "$CONSOLE_LOG"; else echo "[run] (no browser console captured — page never logged)"; fi
echo "[run] ---- summary ----"
grep -iE '✓|✘|[0-9]+ (passed|failed|flaky)|timed out' "$LOG" | tail -40
[ "$EC" = "124" ] && echo "[run] (exit 124 = hit the ${TIMEOUT}s wall-clock cap)"
echo "[run] exit=$EC  log=$LOG"
exit "$EC"
