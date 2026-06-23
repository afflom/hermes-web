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


def _install_thread_surface() -> None:
    """Back Python's ``threading`` with cooperative scheduling on the single-threaded browser event loop — the
    OS primitive (real OS threads) the browser does not provide. This is the hologram/holospaces native-exec
    move applied to concurrency: run the REAL threaded server NATIVE (no emulator interpreter wall, no >360 s
    establishment) by adapting its OS surface, not by emulating a CPU. The runtime is Pyodide's single-threaded
    asyncio WebLoop, so:

      * ``Thread.start()`` runs the target INLINE to completion. A one-shot worker's result / the Event it sets
        is then already observable by whoever waits next — correct for the agent's build→dispatch handoff.
      * A background poll/reaper loop (``while True: time.sleep(N); ...``) cannot run inline (never returns) and
        is meaningless in a single page session; ``time.sleep`` raises inside a cooperatively-run thread so such
        loops unwind cleanly, while a brief sleep falls through as a cooperative no-op.
      * ``Timer`` fires its function immediately (no real delay thread); ``asyncio.to_thread`` runs inline.

    Locks/Events are the real ones — uncontended in a single thread; an Event set by an already-run worker is
    observed set by a later waiter. Idempotent.
    """
    import threading
    import time as _time
    import asyncio as _asyncio

    if getattr(threading, "_holo_coop", False):
        return
    _local = threading.local()
    _RealThread = threading.Thread

    class _CoopYield(BaseException):
        """Unwinds a background poll/reaper loop running cooperatively in the single thread."""

    def _coop_sleep(secs=0.0):
        # A real sleep would freeze the single thread. Inside a cooperatively-run thread a non-trivial sleep
        # marks a background poll loop → unwind it; a brief sleep (or a sleep on the main flow) is a no-op.
        if getattr(_local, "depth", 0) and secs and secs >= 0.05:
            raise _CoopYield()
        return None

    _time.sleep = _coop_sleep

    class _CoopThread(_RealThread):
        def start(self):  # run the target cooperatively, inline, on the single thread
            _local.depth = getattr(_local, "depth", 0) + 1
            try:
                self.run()
            except _CoopYield:
                pass
            except Exception:
                pass
            finally:
                _local.depth -= 1

    class _CoopTimer(_CoopThread):
        # threading.Timer subclasses the REAL Thread (captured at its import), so without this it would call the
        # real start() → "can't start new thread". Fire immediately (single-threaded: no deferral thread).
        def __init__(self, interval, function, args=None, kwargs=None):
            _RealThread.__init__(self)
            self.interval = interval
            self.function = function
            self.args = args if args is not None else []
            self.kwargs = kwargs if kwargs is not None else {}
            self.finished = threading.Event()

        def cancel(self):
            self.finished.set()

        def run(self):
            if not self.finished.is_set():
                self.function(*self.args, **self.kwargs)
            self.finished.set()

    threading.Thread = _CoopThread
    threading.Timer = _CoopTimer

    async def _coop_to_thread(func, /, *args, **kwargs):  # no thread pool to offload to — run inline
        return func(*args, **kwargs)

    _asyncio.to_thread = _coop_to_thread
    threading._holo_coop = True


def install(host=None) -> None:
    """Install the OS-surface shims. Idempotent; parametric over the whole agent. ``host`` (optional) is the
    holospace surface object the process/network adapters route to once wired (G5/G7)."""
    # Cooperative threads FIRST — the gateway spawns a daemon thread at import, so this must precede any import
    # of the agent/server modules (runtime.ts installs the OS surface before importing web_server).
    _install_thread_surface()

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
