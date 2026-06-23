"""The native NETWORK surface — the agent's outbound sockets over the ESTABLISHED holospaces egress (CC-16).

DRY: this does NOT invent an egress. It reuses the exact CC-16 frame protocol the guest's net layer
(`holospaces-web/src/wsnet.rs`) and the router extension (`background.js`) already speak — a raw-TCP relay
multiplexing every connection over one channel by id. The guest got this socket stack for free from its
emulated Linux; running the agent NATIVE (no emulator, the hologram/holospaces way to kill the interpreter
wall) means providing the same socket surface in Python over the same frames. One seam, like the thread surface.

Wire format (tab → ext / ext → tab), id is a u32 big-endian connection id:
    0x01 OPEN  id ip(4) port(2)      0x11 OPENED id
    0x02 DATA  id bytes…             0x12 RDATA  id bytes…
    0x03 CLOSE id                    0x13 CLOSED id   0x14 FAILED id

Blocking is bridged with ``pyodide.ffi.run_sync`` (JSPI): a synchronous ``recv`` suspends the wasm stack so the
worker event loop can deliver the next egress frame, then resumes — the established Pyodide sync-over-async
bridge. So Python's ssl/http and the model SDKs run UNCHANGED on top; only ``socket`` is backed by egress.
"""
from __future__ import annotations

import struct

OP_OPEN = 0x01
OP_DATA = 0x02
OP_CLOSE = 0x03
OP_OPENED = 0x11
OP_RDATA = 0x12
OP_CLOSED = 0x13
OP_FAILED = 0x14


def encode_open(cid: int, ipv4: tuple[int, int, int, int], port: int) -> bytes:
    """tab → ext OPEN: open a TCP socket to ipv4:port for connection ``cid``."""
    return bytes([OP_OPEN]) + struct.pack(">I", cid) + bytes(ipv4) + struct.pack(">H", port)


def encode_data(cid: int, body: bytes) -> bytes:
    """tab → ext DATA: outbound bytes on ``cid``."""
    return bytes([OP_DATA]) + struct.pack(">I", cid) + bytes(body)


def encode_close(cid: int) -> bytes:
    """tab → ext CLOSE: drop ``cid``."""
    return bytes([OP_CLOSE]) + struct.pack(">I", cid)


def parse_frame(frame: bytes) -> tuple[int, int, bytes]:
    """Decode an ext → tab frame into (op, cid, body). Raises on a short/garbage frame."""
    if len(frame) < 5:
        raise ValueError(f"short egress frame: {len(frame)} bytes")
    op = frame[0]
    cid = struct.unpack(">I", frame[1:5])[0]
    return op, cid, bytes(frame[5:])


def ipv4_of(host: str) -> tuple[int, int, int, int] | None:
    """Parse a dotted-quad to a 4-tuple, or None if ``host`` is a name needing DNS resolution."""
    parts = host.split(".")
    if len(parts) != 4:
        return None
    try:
        octets = tuple(int(p) for p in parts)
    except ValueError:
        return None
    if all(0 <= o <= 255 for o in octets):
        return octets  # type: ignore[return-value]
    return None


class WouldBlock(Exception):
    """No buffered data and no blocking pump — raised only in the synchronous (test) path."""


class EgressSocket:
    """A blocking TCP socket backed by CC-16 egress frames — one connection id per socket.

    ``emit(frame)`` hands an outbound frame to the egress channel (worker → main-thread relay → extension).
    ``feed(frame)`` is called with each inbound frame from that channel. The blocking points (connect, recv)
    call ``block()`` to wait for the next inbound frame; in-browser that is a ``pyodide.ffi.run_sync`` that
    suspends the wasm stack so the worker loop can deliver it (JSPI), then resumes. With ssl wrapped over this,
    Python's http + the model SDKs run unchanged on top.
    """

    def __init__(self, cid: int, emit, block=None) -> None:
        self._cid = cid
        self._emit = emit
        self._block = block
        self._rx = bytearray()
        self._state = "init"  # init → opening → open → closed/error

    @property
    def state(self) -> str:
        return self._state

    def connect(self, host: str, port: int) -> None:
        ip = ipv4_of(host)
        if ip is None:
            raise OSError(f"egress connect needs a resolved IPv4 (got name {host!r} — DNS resolves separately)")
        self._state = "opening"
        self._emit(encode_open(self._cid, ip, port))
        while self._state == "opening":
            self._pump()
        if self._state != "open":
            raise OSError(f"egress connect to {host}:{port} failed ({self._state})")

    def feed(self, frame: bytes) -> None:
        op, cid, body = parse_frame(frame)
        if cid != self._cid:
            return
        if op == OP_OPENED:
            self._state = "open"
        elif op == OP_RDATA:
            self._rx += body
        elif op == OP_CLOSED:
            self._state = "closed"
        elif op == OP_FAILED:
            self._state = "error"

    def send(self, data: bytes) -> int:
        if self._state != "open":
            raise OSError(f"send on a non-open egress socket ({self._state})")
        self._emit(encode_data(self._cid, bytes(data)))
        return len(data)

    sendall = send

    def recv(self, bufsize: int) -> bytes:
        while not self._rx and self._state == "open":
            self._pump()
        if self._rx:
            chunk = bytes(self._rx[:bufsize])
            del self._rx[:bufsize]
            return chunk
        return b""  # peer closed → EOF

    def close(self) -> None:
        if self._state in ("opening", "open"):
            self._emit(encode_close(self._cid))
        self._state = "closed"

    def _pump(self) -> None:
        if self._block is None:
            raise WouldBlock("no blocking pump installed (in-browser this is run_sync) and no buffered frame")
        self._block()


def install_http_egress(fetch) -> None:
    """Route the agent's outbound HTTPS through the BROWSER's TLS via the established CORS-free fetch egress —
    the router extension's content role (a service-worker ``fetch`` is CORS-exempt, so it reaches the model
    APIs the page cannot). Pyodide ships NO ``ssl`` module, so Python cannot do TLS over the raw CC-16 socket;
    the browser must. This is still the one established egress, just its HTTP role rather than its socket role.

    ``fetch(method, url, headers, body) -> (status, headers, body)`` performs the request in the extension
    (DNS+TLS+HTTP). ONE httpx transport patch covers every model SDK (anthropic/openai/… all sit on httpx), so
    the agent's provider code runs unchanged. In-browser ``fetch`` bridges sync↔async via ``run_sync`` (JSPI).
    """
    import httpx

    def _handle_request(self, request):  # httpx.HTTPTransport.handle_request
        body = request.read()
        headers = [
            (
                k.decode("latin-1") if isinstance(k, (bytes, bytearray)) else k,
                v.decode("latin-1") if isinstance(v, (bytes, bytearray)) else v,
            )
            for k, v in request.headers.raw
        ]
        status, resp_headers, resp_body = fetch(request.method, str(request.url), headers, bytes(body))
        return httpx.Response(
            status_code=int(status),
            headers=list(resp_headers),
            content=bytes(resp_body),
            request=request,
        )

    httpx.HTTPTransport.handle_request = _handle_request
