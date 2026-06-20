import { describe, it, expect } from "vitest";
import { guestRelativePath } from "./holo-transport";

// The deploy-critical seam: the dashboard prefixes every /api + WS path with its Pages base
// (/hermes-web), but the in-guest web_server.py serves un-prefixed paths. guestRelativePath must strip
// the base so requests reach the guest's routes instead of 404ing.
describe("guestRelativePath", () => {
  const BASE = "/hermes-web";

  it("strips the deploy base from a REST path", () => {
    expect(guestRelativePath("/hermes-web/api/status", BASE)).toBe("/api/status");
    expect(guestRelativePath("/hermes-web/api/sessions?limit=10", BASE)).toBe("/api/sessions?limit=10");
  });

  it("maps the bare base to root (the in-guest index that carries the token)", () => {
    expect(guestRelativePath("/hermes-web", BASE)).toBe("/");
    expect(guestRelativePath("/hermes-web/", BASE)).toBe("/");
  });

  it("strips the base from an absolute ws:// URL, keeping the auth query", () => {
    expect(guestRelativePath("wss://afflom.github.io/hermes-web/api/ws?token=abc", BASE)).toBe("/api/ws?token=abc");
    expect(guestRelativePath("ws://host/hermes-web/api/pty?token=t", BASE)).toBe("/api/pty?token=t");
  });

  it("strips the base from an absolute http(s):// URL", () => {
    expect(guestRelativePath("https://afflom.github.io/hermes-web/api/status", BASE)).toBe("/api/status");
  });

  it("leaves already-guest-relative paths untouched (used by the bootstrap directly)", () => {
    expect(guestRelativePath("/api/status", BASE)).toBe("/api/status");
    expect(guestRelativePath("/", BASE)).toBe("/");
  });

  it("does NOT strip a path that merely starts with the base substring", () => {
    expect(guestRelativePath("/hermes-web-extra/api", BASE)).toBe("/hermes-web-extra/api");
  });

  it("is a no-op when there is no base (server-hosted origin build)", () => {
    expect(guestRelativePath("/api/status", "")).toBe("/api/status");
    expect(guestRelativePath("https://host/api/status", "")).toBe("/api/status");
  });

  it("normalises a relative path to a leading slash", () => {
    expect(guestRelativePath("api/status", BASE)).toBe("/api/status");
  });
});
