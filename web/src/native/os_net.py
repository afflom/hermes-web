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
