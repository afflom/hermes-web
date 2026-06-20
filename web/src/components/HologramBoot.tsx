import { useEffect, useRef, useState, type ReactNode } from "react";
import { bootHologramTransport, type HologramBootProgress } from "../lib/holo-hologram";
import { installStaticFallback } from "../lib/holo-bootstrap";

// HologramBoot — the gate in front of the dashboard on the Pages build. The data plane is the real
// Hermes backend running in an in-browser holospaces RISC-V guest; it must be RESUMED from its warm κ
// and have the loopback transport installed BEFORE the app fires its first /api call. So we show a calm
// boot screen while `bootHologramTransport` runs, then mount the app. If the in-browser backend can't
// come up (no warm-κ published yet, OPFS blocked, etc.) we degrade to the static empty-state transport
// so the dashboard still renders — never a white screen, never a stub placeholder.

const PHASE_LABEL: Record<HologramBootProgress["phase"], string> = {
  wasm: "Loading the holospaces runtime",
  snapshot: "Fetching the warm Hermes machine",
  resume: "Resuming the warm machine",
  attach: "Re-attaching the loopback transport",
  token: "Authenticating with the in-guest server",
  ready: "Ready",
  error: "Falling back to offline view",
};

export function HologramBoot({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<HologramBootProgress>({ phase: "wasm" });
  const [degraded, setDegraded] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke guard — boot exactly once.
    started.current = true;
    (async () => {
      try {
        await bootHologramTransport(setProgress);
      } catch (err) {
        // The in-browser backend isn't available — keep the dashboard usable with empty states.
        console.warn("[holo] in-browser backend unavailable, using offline view:", err);
        installStaticFallback();
        setDegraded(true);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (ready) return <>{children}</>;

  const pct = progress.fraction != null ? Math.round(progress.fraction * 100) : null;
  // Pinned to the concrete `-base` theme tokens (with hard fallbacks): this screen renders OUTSIDE
  // ThemeProvider, where the lens-modulated `--foreground` is alpha-0 (invisible).
  const fg = "var(--foreground-base, #ffffff)";
  const bg = "var(--background-base, #041c1c)";
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5"
      style={{ background: bg, color: fg }}
    >
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 animate-ping rounded-full" style={{ background: fg, opacity: 0.7 }} />
        <span className="text-sm font-medium tracking-tight">Hermes</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="text-xs" style={{ color: fg, opacity: 0.7 }}>
          {degraded ? PHASE_LABEL.error : PHASE_LABEL[progress.phase]}
          {progress.detail ? <span style={{ opacity: 0.6 }}> · {progress.detail}</span> : null}
        </div>
        <div className="h-1 w-56 overflow-hidden rounded-full" style={{ background: fg, opacity: 0.15 }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: pct != null ? `${pct}%` : "40%", background: fg, opacity: 0.6 }}
          />
        </div>
      </div>
      <div className="max-w-xs px-6 text-center text-[11px] leading-relaxed" style={{ color: fg, opacity: 0.5 }}>
        Resuming the Hermes backend in a content-addressed RISC-V guest, in your browser. The first load
        fetches the warm machine; it’s cached for instant warm-starts after that.
      </div>
    </div>
  );
}
