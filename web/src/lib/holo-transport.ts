// holo-transport.ts — the deploy-base path mapping shared by the bridge transport. The dashboard
// prefixes every /api + WebSocket path with its Pages base (e.g. `/hermes-web`, from `api.ts#BASE`),
// but the in-guest `web_server.py` serves UN-prefixed paths (`/api/...`, `/`). The bridge runtime
// (`holo-runtime.ts`) maps each outgoing path through this before dialing the guest, so requests reach
// the guest's routes instead of 404ing. Pure + unit-tested.

/** Map a dashboard URL to the GUEST-relative path (+query), stripping the deploy `base`. Handles
 * absolute http(s)/ws(s) URLs (takes pathname+search), already-relative paths, and the bare base → `/`.
 * A `base` of "" (the server-hosted origin build) is a no-op. */
export function guestRelativePath(input: string, base: string): string {
  let p: string;
  if (/^[a-z]+:\/\//i.test(input)) {
    const u = new URL(input);
    p = u.pathname + u.search;
  } else if (/^wss?:\/\//i.test(input)) {
    const u = new URL(input);
    p = u.pathname + u.search;
  } else {
    p = input.startsWith("/") ? input : "/" + input;
  }
  if (base && (p === base || p.startsWith(base + "/"))) p = p.slice(base.length) || "/";
  return p;
}
