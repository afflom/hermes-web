import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BridgeRuntime, type HoloWorkspace } from "./holo-runtime";

// Drive the runtime against a scripted mock Workspace — proving the single pump services loopback
// fetches AND egress, with no real guest. The HTTP framing is the real holo-wire codec.

function mockWs(): HoloWorkspace & { egressQueue: Uint8Array[]; inboundGot: Uint8Array[]; lastRequest?: string } {
  const responses = new Map<number, Uint8Array>();
  const open = new Map<number, boolean>();
  let nextId = 1;
  const state = {
    egressQueue: [] as Uint8Array[],
    inboundGot: [] as Uint8Array[],
    lastRequest: undefined as string | undefined,
    run: () => false,
    terminal_delta: () => "",
    dial_guest: () => {
      const id = nextId++;
      open.set(id, true);
      return id;
    },
    guest_send: (id: number, data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      state.lastRequest = text;
      // Canned 200 response with a small JSON body, keyed by connection.
      const body = '{"ok":true}';
      const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
      responses.set(id, new TextEncoder().encode(resp));
    },
    guest_recv: (id: number) => {
      const r = responses.get(id);
      if (r) {
        responses.delete(id);
        return r;
      }
      return new Uint8Array(0);
    },
    guest_close: (id: number) => open.set(id, false),
    guest_is_open: (id: number) => open.get(id) ?? false,
    egress_outbound: () => state.egressQueue.shift(),
    egress_inbound: (f: Uint8Array) => state.inboundGot.push(f),
  };
  return state;
}

describe("BridgeRuntime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("services a loopback /api fetch over the single pump and returns the guest response", async () => {
    const ws = mockWs();
    const rt = new BridgeRuntime(ws, { port: 9119 });
    rt.start();
    const p = rt.fetch("/api/status"); // base-strip is covered by guestRelativePath's own tests
    await vi.advanceTimersByTimeAsync(50);
    const res = await p;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ws.lastRequest?.split("\r\n")[0]).toBe("GET /api/status HTTP/1.1");
    rt.stop();
  });

  it("drains the guest's egress frames to the extension channel", async () => {
    const ws = mockWs();
    const sent: Uint8Array[] = [];
    const egress = { send: (f: Uint8Array) => sent.push(f), onFrame: () => {}, close: () => {} };
    const rt = new BridgeRuntime(ws, { egress });
    rt.start();
    ws.egressQueue.push(new Uint8Array([0x01, 0, 0, 0, 1])); // an OPEN frame from the guest NAT
    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toHaveLength(1);
    expect(Array.from(sent[0])).toEqual([0x01, 0, 0, 0, 1]);
    rt.stop();
  });

  it("feeds the extension's reply frames back into the guest NAT", async () => {
    const ws = mockWs();
    let deliver: ((f: Uint8Array) => void) | null = null;
    const egress = { send: () => {}, onFrame: (cb: (f: Uint8Array) => void) => (deliver = cb), close: () => {} };
    const rt = new BridgeRuntime(ws, { egress });
    rt.start();
    deliver!(new Uint8Array([0x11, 0, 0, 0, 1])); // OPENED from the host
    await vi.advanceTimersByTimeAsync(20);
    expect(ws.inboundGot).toHaveLength(1);
    expect(Array.from(ws.inboundGot[0])).toEqual([0x11, 0, 0, 0, 1]);
    rt.stop();
  });

  it("rejects a fetch when loopback ingress is not enabled (dial returns undefined)", async () => {
    const ws = mockWs();
    ws.dial_guest = () => undefined;
    const rt = new BridgeRuntime(ws);
    rt.start();
    await expect(rt.fetch("/api/status")).rejects.toThrow(/loopback ingress/);
    rt.stop();
  });
});
