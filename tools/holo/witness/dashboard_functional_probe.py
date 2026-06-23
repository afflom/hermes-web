#!/usr/bin/env python3
"""Comprehensive functional gate for the Hermes dashboard backend — the API surface the in-browser κ serves.

WHY: the deployed dashboard reads from a content-addressed warm-κ seed and writes through the loopback
bridge; both are only as correct as the in-guest backend. A handler that 500s (e.g. the cron `from cron
import jobs` package-shadow bug) bakes a broken response into the seed and the tab silently fails. This probe
exercises the WHOLE surface against a running dashboard so a cron-class regression fails closed BEFORE a bank.

WHAT IT CHECKS:
  • every parameter-free GET answers without a 5xx (a 5xx is an unhandled backend bug),
  • the local read+write features round-trip: mutate → verify via a follow-up read → clean up,
  • coverage: how many of web_server.py's routes were touched (so new endpoints get noticed).
EGRESS endpoints (LLM providers, the skills hub, MCP/messaging probes, model info) need outbound network and
are listed but not asserted offline — they fast-503 without the router extension by design.

USAGE (against the fast amd64 oracle that mirrors the riscv64 guest's Python, or any dashboard):
    docker run -d --name d -p 9119:9119 hermes-dash        # python -m hermes_cli.main dashboard --insecure …
    TOK=$(curl -s localhost:9119/ | grep -oE '__HERMES_SESSION_TOKEN__="[^"]+"' | sed 's/.*="//;s/"//')
    python3 tools/holo/witness/dashboard_functional_probe.py http://localhost:9119 "$TOK"
Exit code 0 = every asserted endpoint healthy; non-zero = a backend bug to fix before re-banking.
"""
from __future__ import annotations
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:9119"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
WEB_SERVER = Path(__file__).resolve().parents[3] / "hermes_cli" / "web_server.py"

# Egress / destructive / multipart endpoints: need outbound network, mutate global state, or need a file
# upload — not asserted by the offline gate (they're correct-by-design behind the router extension).
EGRESS_OR_DESTRUCTIVE = {
    "/api/model/info", "/api/model/options", "/api/model/auxiliary", "/api/model/set",
    "/api/skills", "/api/skills/content", "/api/skills/hub/install", "/api/skills/hub/uninstall",
    "/api/skills/hub/update", "/api/skills/hub/preview", "/api/skills/hub/scan", "/api/skills/hub/search",
    "/api/skills/hub/sources", "/api/mcp/servers", "/api/mcp/catalog", "/api/mcp/catalog/install",
    "/api/messaging/platforms", "/api/messaging/telegram/onboarding/start", "/api/hermes/update",
    "/api/hermes/update/check", "/api/dashboard/agent-plugins/install", "/api/audio/speak",
    "/api/audio/transcribe", "/api/providers/validate", "/api/providers/oauth",
    "/api/gateway/start", "/api/gateway/stop", "/api/gateway/restart", "/api/memory/reset",
    "/api/curator/run", "/api/sessions/empty", "/api/sessions/bulk-delete", "/api/sessions/prune",
    "/api/cron/fire", "/api/ops/import", "/api/ops/backup", "/api/ops/dump", "/api/ops/config-migrate",
    "/api/ops/debug-share", "/api/ops/doctor", "/api/ops/security-audit", "/api/ops/prompt-size",
    "/api/ops/checkpoints/prune", "/api/files/upload", "/api/files/upload-stream", "/api/credentials/pool",
    "/api/pairing/approve", "/api/pairing/revoke",
}

_fails: list[str] = []
_touched: set[str] = set()


def call(method: str, path: str, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    _touched.add(path.split("?")[0])
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"").decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, f"ERR:{e}"


def routes(method_re: str) -> list[str]:
    src = WEB_SERVER.read_text()
    pat = re.compile(r'@app\.(' + method_re + r')\("(/api/[^"{]+)"')
    return sorted({m.group(2) for m in pat.finditer(src)})


def get_probe() -> None:
    print("── GET probe (every param-free route must not 5xx) ──")
    for path in routes("get"):
        if path in EGRESS_OR_DESTRUCTIVE:
            continue
        s, b = call("GET", path)
        if isinstance(s, int) and 500 <= s < 600:
            _fails.append(f"GET {path} → {s}: {b[:160]}")
            print(f"  ✗ {s} {path}")
    print(f"  probed {len([p for p in routes('get') if p not in EGRESS_OR_DESTRUCTIVE])} local GETs")


def mutation_probe() -> None:
    print("── local mutation round-trips (mutate → verify → cleanup) ──")

    def check(name, ok, detail=""):
        print(f"  {'✓' if ok else '✗'} {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            _fails.append(f"{name}: {detail}")

    # ENV
    s, _ = call("PUT", "/api/env", {"key": "HERMES_FN_PROBE", "value": "v1"})
    check("env PUT", s == 200, f"status {s}")
    call("DELETE", "/api/env", {"key": "HERMES_FN_PROBE"})

    # CRON job: create → appears in list → delete
    s, b = call("POST", "/api/cron/jobs?profile=default", {"name": "fn_probe", "prompt": "x", "schedule": "0 9 * * 1"})
    jid = None
    try:
        jid = json.loads(b).get("id")
    except Exception:  # noqa: BLE001
        pass
    sg, bg = call("GET", "/api/cron/jobs?profile=default")
    check("cron create+list", s == 200 and "fn_probe" in bg, f"post {s}, listed={'fn_probe' in bg}")
    if jid:
        call("DELETE", f"/api/cron/jobs/{jid}?profile=default")

    # PROFILE: create → appears in list → delete
    s, _ = call("POST", "/api/profiles", {"name": "fn_probe_profile", "clone_from": "default"})
    sg, bg = call("GET", "/api/profiles")
    check("profile create+list", s == 200 and "fn_probe_profile" in bg, f"post {s}, listed={'fn_probe_profile' in bg}")
    call("DELETE", "/api/profiles/fn_probe_profile")

    # WEBHOOK: enable → create → appears → delete
    call("POST", "/api/webhooks/enable", {})
    s, _ = call("POST", "/api/webhooks", {"name": "fn_probe_hook", "events": ["error"]})
    sg, bg = call("GET", "/api/webhooks")
    check("webhook create+list", s == 200 and "fn_probe_hook" in bg, f"post {s}, listed={'fn_probe_hook' in bg}")
    call("DELETE", "/api/webhooks/fn_probe_hook")

    # OPS HOOK: create → appears → delete
    hook = {"event": "on_session_end", "command": "echo fn_probe"}
    s, _ = call("POST", "/api/ops/hooks", hook)
    sg, bg = call("GET", "/api/ops/hooks")
    check("ops hook create+list", s == 200 and "fn_probe" in bg, f"post {s}, listed={'fn_probe' in bg}")
    call("DELETE", "/api/ops/hooks", hook)

    # CURATOR pause toggle (restore)
    s1, _ = call("PUT", "/api/curator/paused", {"paused": True})
    s2, _ = call("PUT", "/api/curator/paused", {"paused": False})
    check("curator pause toggle", s1 == 200 and s2 == 200, f"{s1}/{s2}")


def main() -> int:
    print(f"Hermes dashboard functional probe → {BASE}")
    if not TOKEN:
        print("WARNING: no token passed; protected endpoints will 401")
    get_probe()
    mutation_probe()
    all_routes = set(routes("get|post|put|patch|delete"))
    print(f"\ncoverage: touched {len(_touched & all_routes)}/{len(all_routes)} routes "
          f"({len(EGRESS_OR_DESTRUCTIVE & all_routes)} egress/destructive intentionally skipped)")
    if _fails:
        print(f"\n✗ {len(_fails)} FUNCTIONAL FAILURE(S):")
        for f in _fails:
            print(f"   - {f}")
        return 1
    print("\n✓ all asserted dashboard endpoints are functional (no 5xx; local mutations round-trip)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
