import { useEffect, useRef, useState, type ReactNode } from "react";
import { bootHologramTransport, type HologramBootProgress } from "../lib/holo-hologram";
import { HoloEgressPrompt } from "./HoloEgressPrompt";

// HologramBoot — the gate in front of the dashboard on the Pages build. The data plane is the real
// Hermes backend running in an in-browser holospaces RISC-V guest; it must be RESUMED from its warm κ
// (the disk paged from the OPFS κ-store) and have the loopback transport installed BEFORE the app fires
// its first /api call. So we show a boot screen while `bootHologramTransport` runs, then mount the app.
//
// There is no fake fallback. If the in-browser backend cannot come up we show an honest error with a
// retry — never fabricated empty data, never a stub. The dashboard's data plane is holospaces or nothing.

const PHASE_LABEL: Record<HologramBootProgress["phase"], string> = {
  wasm: "Loading the holospaces runtime",
  snapshot: "Fetching the warm Hermes machine",
  disk: "Streaming the guest disk to local storage",
  resume: "Resuming the warm machine",
  egress: "Connecting the agent's network",
  attach: "Re-attaching the loopback transport",
  token: "Authenticating with the in-guest server",
  ready: "Ready",
  error: "Could not start the in-browser backend",
};

export function HologramBoot({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<HologramBootProgress>({ phase: "wasm" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (started.current === attempt) return; // boot once per attempt (StrictMode-safe)
    started.current = attempt;
    setError(null);
    (async () => {
      try {
        await bootHologramTransport(setProgress);
        setReady(true);
      } catch (err) {
        console.error("[holo] in-browser backend failed to start:", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [attempt]);

  if (ready)
    return (
      <>
        {children}
        <HoloEgressPrompt />
      </>
    );

  // Pinned to the concrete `-base` theme tokens (with hard fallbacks): this screen renders OUTSIDE
  // ThemeProvider, where the lens-modulated `--foreground` is alpha-0 (invisible).
  const fg = "var(--foreground-base, #ffffff)";
  const bg = "var(--background-base, #041c1c)";
  const pct = progress.fraction != null ? Math.round(progress.fraction * 100) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5"
      style={{ background: bg, color: fg }}
    >
      <div className="flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: fg, opacity: 0.7, animation: error ? "none" : "ping 1s cubic-bezier(0,0,0.2,1) infinite" }}
        />
        <span className="text-sm font-medium tracking-tight">Hermes</span>
      </div>

      {error ? (
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <div className="text-xs" style={{ color: fg, opacity: 0.85 }}>{PHASE_LABEL.error}</div>
          <div className="text-[11px] leading-relaxed" style={{ color: fg, opacity: 0.5 }}>{error}</div>
          <button
            type="button"
            onClick={() => { setReady(false); setAttempt((a) => a + 1); }}
            className="rounded-md px-3 py-1.5 text-xs transition-opacity hover:opacity-80"
            style={{ border: `1px solid ${fg}`, color: fg }}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center gap-2">
            <div className="text-xs" style={{ color: fg, opacity: 0.7 }}>
              {PHASE_LABEL[progress.phase]}
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
            Resuming the Hermes backend in a content-addressed RISC-V guest, in your browser. The first
            load fetches the warm machine; it’s cached for instant warm-starts after that.
          </div>
        </>
      )}
    </div>
  );
}
