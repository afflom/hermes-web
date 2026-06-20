import { useEffect, useState } from "react";
import { detectEgressExtensionId } from "../lib/holo-egress";

// HoloEgressPrompt — a calm, dismissible banner shown ONLY when the in-browser agent needs network
// access (model APIs, git, pip/npm) and the holospaces router extension isn't installed. The dashboard
// itself works without it (the loopback transport is in-process); only the agent's OUTBOUND traffic
// needs the extension's raw sockets. The banner auto-hides the instant the extension announces itself
// (the content script sets `data-holospaces-egress` on <html>) — no reload, no reconfiguration.
//
// Per "only use the extension for features absolutely needed (to overcome CORS)": this nudges the
// install solely for egress; it never gates the dashboard.

const EXT_ZIP = "holo/holospaces-router-extension.zip";

export function HoloEgressPrompt() {
  const [installed, setInstalled] = useState<boolean>(() => detectEgressExtensionId() != null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (installed) return;
    // Watch <html> for the extension's beacon; hide the moment it appears.
    const check = () => {
      if (detectEgressExtensionId() != null) setInstalled(true);
    };
    check();
    let obs: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      obs = new MutationObserver(check);
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-holospaces-egress"] });
    }
    try {
      window.dispatchEvent(new Event("holospaces-egress-probe"));
    } catch {
      /* ignore */
    }
    const poll = setInterval(check, 2000);
    return () => {
      obs?.disconnect();
      clearInterval(poll);
    };
  }, [installed]);

  if (installed || dismissed) return null;

  const base = import.meta.env.BASE_URL || "/";
  const zipHref = `${base}${EXT_ZIP}`.replace(/([^:])\/\//g, "$1/");

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-40 w-[min(92vw,40rem)] -translate-x-1/2 rounded-lg border p-3 text-xs shadow-lg"
      style={{
        background: "var(--color-card, #07201f)",
        color: "var(--foreground-base, #ffffff)",
        borderColor: "color-mix(in srgb, var(--foreground-base, #fff) 18%, transparent)",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 leading-relaxed">
          <div className="font-medium">Enable the agent’s network</div>
          <div style={{ opacity: 0.7 }}>
            The dashboard runs fully in your browser. For the agent to reach model APIs, git, and
            packages, install the holospaces router extension (raw sockets a tab can’t open) and load it
            via <code>chrome://extensions</code> → “Load unpacked”.
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <a
            href={zipHref}
            download
            className="rounded-md px-2.5 py-1 transition-opacity hover:opacity-80"
            style={{ border: "1px solid currentColor" }}
          >
            Download extension
          </a>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-1.5 py-0.5 transition-opacity hover:opacity-80"
            style={{ opacity: 0.6 }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
