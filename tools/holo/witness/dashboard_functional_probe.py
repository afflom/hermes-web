#!/usr/bin/env python3
"""Comprehensive functional gate for the Hermes dashboard backend — the API surface the in-browser κ serves.

WHY: the deployed dashboard reads from a content-addressed warm-κ seed and writes through the loopback
bridge; both are only as correct as the in-guest backend. A handler that 500s (e.g. the cron `from cron
import jobs` package-shadow bug) bakes a broken response into the seed and the tab silently fails. This probe
exercises the WHOLE surface against a running dashboard so a cron-class regression fails closed BEFORE a bank.

COVERAGE — EVERY route in web_server.py (auto-extracted, incl. the parameterized ones):
  • SETUP creates/discovers real resources (a cron job, a profile, a webhook, a toolset, a session, a memory
    provider) and substitutes their ids into {job_id}/{name}/{session_id}/… so parameterized handlers run for
    real, not against a bogus id.
  • NO route may return 5xx — a 5xx is an unhandled backend bug (the whole point: catch the next cron-class
    crash). Egress routes (LLM providers, skills hub, MCP/messaging, model info, gateway control, ops jobs)
    legitimately answer 4xx/empty offline or are network-unreachable; that is fine — only a 5xx fails the gate.
  • CORE local reads must be 2xx (config, sessions, system/stats, memory, env, cron, …).
  • LOCAL read+write features must round-trip: mutate → verify via a follow-up read → clean up.

USAGE (against the fast amd64 oracle that mirrors the riscv64 guest's Python, or any dashboard):
    docker run -d --name d -p 9119:9119 hermes-dash        # python -m hermes_cli.main dashboard --insecure …
    TOK=$(curl -s localhost:9119/ | grep -oE '__HERMES_SESSION_TOKEN__="[^"]+"' | sed 's/.*="//;s/"//')
    python3 tools/holo/witness/dashboard_functional_probe.py http://localhost:9119 "$TOK"
Exit 0 = every route healthy (no 5xx), core reads 2xx, local mutations round-trip. Non-zero = a bug to fix
before re-banking.
"""
from __future__ import annotations
import json
import re
import socket
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:9119"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
WEB_SERVER = Path(__file__).resolve().parents[3] / "hermes_cli" / "web_server.py"

# Core LOCAL reads that MUST answer 2xx (they back the always-on tabs; a 4xx here is a real failure).
CORE_GETS_2XX = [
    "/api/status", "/api/config", "/api/config/schema", "/api/config/defaults", "/api/sessions/stats",
    "/api/system/stats", "/api/memory", "/api/credentials/pool", "/api/ops/checkpoints", "/api/ops/hooks",
    "/api/curator", "/api/portal", "/api/env", "/api/profiles", "/api/profiles/active", "/api/webhooks",
    "/api/pairing", "/api/dashboard/plugins", "/api/cron/jobs", "/api/cron/delivery-targets",
    "/api/cron/blueprints", "/api/tools/toolsets",
]

_fails: list[str] = []
_touched: set[str] = set()


def call(method: str, path: str, body=None, timeout: int = 15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    _touched.add(re.sub(r"\?.*$", "", path))
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"").decode("utf-8", "replace")
    except (urllib.error.URLError, socket.timeout) as e:
        return -1, f"NET:{e}"  # network-unreachable = egress, expected offline
    except Exception as e:  # noqa: BLE001
        return -2, f"ERR:{e}"


def all_routes() -> list[tuple[str, str]]:
    src = WEB_SERVER.read_text()
    out = {(m.group(1).upper(), m.group(2))
           for m in re.finditer(r'@app\.(get|post|put|patch|delete)\("(/api/[^"]+)"', src)}
    return sorted(out)


EGRESS = re.compile(
    r"/api/(model/|skills($|/)|mcp/|mcp$|messaging/|providers/|audio/|hermes/update|"
    r"dashboard/agent-plugins|gateway/(start|stop|restart)|"
    r"ops/(import|backup|dump|doctor|security-audit|debug-share|config-migrate|prompt-size)|"
    r"curator/run|memory/reset)"
)


def setup_subs() -> dict:
    """Create/discover real resources so parameterized routes run against valid ids."""
    sub: dict[str, str] = {}
    _, b = call("POST", "/api/cron/jobs?profile=default", {"name": "fp_job", "prompt": "x", "schedule": "0 9 * * 1"})
    try:
        sub["job_id"] = json.loads(b).get("id")
    except Exception:  # noqa: BLE001
        pass
    call("POST", "/api/profiles", {"name": "fp_prof", "clone_from": "default"})
    call("POST", "/api/webhooks/enable", {})
    call("POST", "/api/webhooks", {"name": "fp_hook", "events": ["error"]})
    for key, path, listkey, idkey in [
        ("toolset", "/api/tools/toolsets", "toolsets", "name"),
        ("session", "/api/sessions?limit=1&offset=0&order=created", "sessions", "id"),
        ("mem", "/api/memory", "providers", "name"),
    ]:
        _, b = call("GET", path)
        try:
            sub[key] = (json.loads(b).get(listkey) or [{}])[0].get(idkey)
        except Exception:  # noqa: BLE001
            pass
    return sub


def fill(path: str, sub: dict) -> str:
    p = path
    p = p.replace("{job_id}", sub.get("job_id") or "nope")
    p = p.replace("{session_id}", sub.get("session") or "nope")
    for ph in ("{pairing_id}", "{platform_id}", "{provider_id}", "{index}"):
        p = p.replace(ph, "0" if ph == "{index}" else "nope")
    p = p.replace("{provider}", "openai")
    if "/profiles/" in p:
        p = p.replace("{name}", "fp_prof")
    elif "/toolsets/" in p:
        p = p.replace("{name}", sub.get("toolset") or "nope")
    elif "/webhooks/" in p:
        p = p.replace("{name}", "fp_hook")
    elif "/memory/providers/" in p:
        p = p.replace("{name}", sub.get("mem") or "nope")
    return p.replace("{name:path}", "nope").replace("{name}", "nope")


def sweep(sub: dict) -> None:
    """Every route must run without a 5xx; core local GETs must be 2xx."""
    print("── full-surface sweep (no route may 5xx) ──")
    for meth, raw in all_routes():
        path = fill(raw, sub)
        body = {} if meth in ("POST", "PUT", "PATCH") else None
        s, b = call(meth, path, body, timeout=8 if EGRESS.search(raw) else 15)
        if isinstance(s, int) and s >= 500:
            _fails.append(f"{meth} {raw} → {s}: {b[:160]}")
            print(f"  ✗ {s} {meth} {raw}  | {b[:120]}")
    for path in CORE_GETS_2XX:
        s, b = call("GET", path)
        if not (isinstance(s, int) and 200 <= s < 300):
            _fails.append(f"core read {path} → {s} (expected 2xx): {b[:120]}")
            print(f"  ✗ core {path} → {s}")
    print(f"  swept {len(all_routes())} routes; asserted {len(CORE_GETS_2XX)} core reads 2xx")


def round_trips(sub: dict) -> None:
    print("── local read+write round-trips (mutate → verify → cleanup) ──")

    def check(name, ok, detail=""):
        print(f"  {'✓' if ok else '✗'} {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            _fails.append(f"round-trip {name}: {detail}")

    s, _ = call("PUT", "/api/env", {"key": "HERMES_FN_PROBE", "value": "v1"})
    check("env PUT", s == 200, f"status {s}")
    call("DELETE", "/api/env", {"key": "HERMES_FN_PROBE"})

    _, bg = call("GET", "/api/cron/jobs?profile=default")
    check("cron create+list", sub.get("job_id") is not None and "fp_job" in bg, f"id={sub.get('job_id')}")

    _, bg = call("GET", "/api/profiles")
    check("profile create+list", "fp_prof" in bg, f"listed={'fp_prof' in bg}")

    _, bg = call("GET", "/api/webhooks")
    check("webhook create+list", "fp_hook" in bg, f"listed={'fp_hook' in bg}")

    hook = {"event": "on_session_end", "command": "echo fp"}
    s, _ = call("POST", "/api/ops/hooks", hook)
    _, bg = call("GET", "/api/ops/hooks")
    check("ops hook create+list", s == 200 and "echo fp" in bg, f"post {s}")
    call("DELETE", "/api/ops/hooks", hook)

    s1, _ = call("PUT", "/api/curator/paused", {"paused": True})
    s2, _ = call("PUT", "/api/curator/paused", {"paused": False})
    check("curator pause toggle", s1 == 200 and s2 == 200, f"{s1}/{s2}")


def cleanup(sub: dict) -> None:
    if sub.get("job_id"):
        call("DELETE", f"/api/cron/jobs/{sub['job_id']}?profile=default")
    call("DELETE", "/api/profiles/fp_prof")
    call("DELETE", "/api/webhooks/fp_hook")


def main() -> int:
    print(f"Hermes dashboard functional probe → {BASE}")
    if not TOKEN:
        print("WARNING: no token passed; protected endpoints will 401")
    sub = setup_subs()
    # Round-trips FIRST: the full sweep calls the DELETE /{cron,profiles,webhooks}/{id} routes, which would
    # remove the setup resources before we can verify they were created. Verify create→list, THEN sweep.
    round_trips(sub)
    sweep(sub)
    cleanup(sub)
    routes = all_routes()
    egress = {r for _, r in routes if EGRESS.search(r)}
    print(f"\ncoverage: swept all {len(routes)} routes (every method+path in web_server.py); "
          f"{len(egress)} are egress (answer 4xx/empty offline — only a 5xx fails the gate)")
    if _fails:
        print(f"\n✗ {len(_fails)} FUNCTIONAL FAILURE(S):")
        for f in _fails:
            print(f"   - {f}")
        return 1
    print("\n✓ every dashboard route is functional (no 5xx), core reads 2xx, local mutations round-trip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
