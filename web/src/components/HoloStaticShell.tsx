// HoloStaticShell — the no-backend landing rendered when the Hermes dashboard is served statically
// (transport mode === "static"), e.g. on GitHub Pages. The dashboard is a live agent UI that needs a
// backend (`hermes dashboard`); a static host has none, so its data routes have nothing to render.
// Rather than white-screen, the static build presents this intentional landing. It is fully
// self-contained (no providers, no data fetches, inline styles) so it renders even if every /api route
// is inert — the one thing a static host must never do is crash.
import { useEffect } from "react";

const ACCENT = "#7defc9";

export default function HoloStaticShell() {
  useEffect(() => {
    document.title = "Hermes";
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
        The Hermes agent dashboard. This static build isn’t connected to a backend, so there’s no live
        agent to show here. Run <code style={{ color: ACCENT }}>hermes dashboard</code> locally to use the
        full interface.
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
        hermes-web · static build
      </code>
    </main>
  );
}
