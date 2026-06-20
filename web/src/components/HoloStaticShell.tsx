// HoloStaticShell — the no-backend shell rendered on the content-addressed Pages deploy before a guest
// workspace is booted (transport mode === "static"). The full dashboard is a live agent UI that needs a
// backend (the in-guest web_server.py over the loopback bridge, or a server-hosted `hermes dashboard`);
// with no backend its data routes have nothing to render. Rather than white-screen, the static deploy
// presents this intentional landing. It is fully self-contained (no providers, no data fetches, inline
// styles) so it renders even if every /api route is inert — the one thing a static host must never do is
// crash. When the holospace launcher boots a guest and injects __HOLO_GUEST_BRIDGE__, the bootstrap
// selects the hologram transport instead and the full dashboard mounts.
import { useEffect } from "react";

const ACCENT = "#7defc9";

export default function HoloStaticShell() {
  useEffect(() => {
    document.title = "Hermes · holospace";
  }, []);
  return (
    <main
      data-testid="holo-static-shell"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
        padding: "2rem",
        textAlign: "center",
        background: "radial-gradient(ellipse at 50% 30%, #11201c 0%, #0a0f0d 60%, #070a09 100%)",
        color: "#e7f3ee",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        aria-hidden
        style={{
          width: 72,
          height: 72,
          borderRadius: 18,
          border: `1.5px solid ${ACCENT}`,
          display: "grid",
          placeItems: "center",
          boxShadow: `0 0 40px -8px ${ACCENT}66`,
          color: ACCENT,
          fontSize: 34,
          fontWeight: 700,
        }}
      >
        H
      </div>
      <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 650, letterSpacing: "-0.01em" }}>
        Hermes
      </h1>
      <p style={{ margin: 0, maxWidth: 520, lineHeight: 1.55, color: "#a9c4ba", fontSize: "0.95rem" }}>
        The Hermes agent dashboard, served as a content-addressed holospace. This is the no-backend shell:
        boot a workspace from the holospace launcher to start the agent runtime, and the live dashboard
        mounts here automatically.
      </p>
      <code
        style={{
          fontSize: "0.72rem",
          color: ACCENT,
          background: "#0e1714",
          border: "1px solid #1d2e29",
          borderRadius: 8,
          padding: "0.35rem 0.6rem",
        }}
      >
        transport: static · served by κ
      </code>
    </main>
  );
}
