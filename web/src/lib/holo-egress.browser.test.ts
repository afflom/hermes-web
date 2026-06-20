import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectEgressExtensionId, connectEgress, egressRuntimeAvailable } from "./holo-egress";

// The egress connector shuttles OPAQUE frames between the wasm guest and the extension. We never parse
// the frame format (the substrate + extension own it); we test detection and the carrier shuttle.

describe("detectEgressExtensionId", () => {
  // Runs in a REAL browser — use the real <html> the content script writes the beacon onto.
  afterEach(() => document.documentElement.removeAttribute("data-holospaces-egress"));

  it("returns null when the extension hasn't announced", () => {
    expect(detectEgressExtensionId()).toBeNull();
  });

  it("reads the extension id from the content-script beacon", () => {
    document.documentElement.setAttribute("data-holospaces-egress", "abcdef123");
    expect(detectEgressExtensionId()).toBe("abcdef123");
  });

  it("treats an empty attribute as absent", () => {
    document.documentElement.setAttribute("data-holospaces-egress", "");
    expect(detectEgressExtensionId()).toBeNull();
  });
});

describe("connectEgress", () => {
  let listeners: ((msg: unknown) => void)[];
  let posted: unknown[];
  let disconnectCbs: (() => void)[];

  beforeEach(() => {
    listeners = [];
    posted = [];
    disconnectCbs = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        connect: vi.fn(() => ({
          postMessage: (m: unknown) => posted.push(m),
          disconnect: vi.fn(),
          onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
          onDisconnect: { addListener: (cb: () => void) => disconnectCbs.push(cb) },
        })),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("reports runtime availability from chrome.runtime.connect", () => {
    expect(egressRuntimeAvailable()).toBe(true);
  });

  it("sends a guest frame to the extension as a plain byte array (structured-clone safe)", () => {
    const ch = connectEgress("ext-id");
    expect(ch).not.toBeNull();
    ch!.send(new Uint8Array([1, 2, 0xff]));
    expect(posted).toEqual([[1, 2, 255]]);
  });

  it("delivers extension frames to onFrame, normalising number[] → Uint8Array", () => {
    const ch = connectEgress("ext-id")!;
    const got: Uint8Array[] = [];
    ch.onFrame((f) => got.push(f));
    // Extension posts a structured-cloned byte array.
    listeners[0]([0x11, 0, 0, 0, 7]);
    expect(got).toHaveLength(1);
    expect(Array.from(got[0])).toEqual([0x11, 0, 0, 0, 7]);
  });

  it("returns null when there is no chrome.runtime (non-Chromium / no extension)", () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    expect(connectEgress("ext-id")).toBeNull();
    expect(egressRuntimeAvailable()).toBe(false);
  });
});
