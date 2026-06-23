"""The ONE OS-surface adapter for running the real Hermes Python natively (Pyodide) on the browser peer.

DRY: a single shim that backs Python's OS primitives with the holospace surface — never per-module/per-call
patches. The browser has no processes/PTY/native FS, so the substrate provides them over the CC-33 bridge:

  * filesystem   → Pyodide FS (IDBFS/OPFS-persisted HOME for config/state); holospace FS (CC-15) when wired
  * process/PTY  → holospace process surface (CC-11): subprocess/execvp routed to ``HOST.exec`` (the agent's
                   shell tools). Until a HOST is installed, these raise a clear, catchable error.
  * network      → the existing extension egress bridge (holo-egress), reused (sockets are NOT reinvented here)
  * psutil/tty   → graceful: the agent probes these lazily; we degrade to OSError so TTY/process detection
                   falls back the same way it would on a non-tty.

``install(host=None)`` is idempotent and parametric: it supports the FULL agent (every OS module it may import),
not a hand-picked subset. ``host`` is the JS-provided holospace surface (process/exec, fs, net); pass None for
the dashboard-only path (no shell tools) and a real host once the process surface (G5) is wired.
"""
from __future__ import annotations

import errno
import sys
import types

# OS modules Pyodide does not ship that Hermes imports EAGERLY without a guard. We make them importable but
# inert (attribute access raises a catchable OSError) so the eager import succeeds and any real use degrades the
# same way it would on a non-tty. NOTE: `termios`/`pty` are deliberately NOT here — they're reached only through
# the PTY/terminal libs, which Hermes guards with `except ImportError`, so letting them be genuinely absent makes
# the agent's PTY degrade cleanly (the holospace terminal surface, G5) without us faking terminal internals.
_OS_MODULES = ("psutil", "fcntl", "resource", "grp", "pwd", "spwd", "nis", "crypt")


def _stub_module(name: str, host) -> types.ModuleType:
    class _Stub(types.ModuleType):
        error = OSError  # fcntl-style exception classes callers may `except`
        __all__ = []  # `from <stub> import *` imports nothing rather than iterating a function (TypeError)

        def __getattr__(self, attr):
            def _unsupported(*a, **k):
                raise OSError(errno.ENOTTY, f"{name}.{attr} unsupported in-browser (holospace surface pending)")

            return _unsupported

    return _Stub(name)


def install(host=None) -> None:
    """Install the OS-surface shims. Idempotent; parametric over the whole agent. ``host`` (optional) is the
    holospace surface object the process/network adapters route to once wired (G5/G7)."""
    for name in _OS_MODULES:
        if name not in sys.modules:
            sys.modules[name] = _stub_module(name, host)

    # The process surface (subprocess/execvp/PTY) is the agent's tool-execution path. Route it to the holospace
    # process surface when a host is present; otherwise leave Python's subprocess to raise its own clear error
    # on use (the dashboard never calls it). This is the single seam G5 fills — no scattered subprocess patches.
    if host is not None and getattr(host, "exec", None) is not None:
        _install_process_surface(host)


def _install_process_surface(host) -> None:
    """Back subprocess/os.exec*/pty with the holospace process surface (CC-11). One seam, filled at G5."""
    # Intentionally a single, documented integration point. Implemented when the holospace process-surface API
    # is wired (see PLAN.md G5); kept here so the routing lives in ONE place, DRY.
    raise NotImplementedError("process surface (G5) not yet wired — install(host=None) for the dashboard path")
