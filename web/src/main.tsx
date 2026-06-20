import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { SystemActionsProvider } from "./contexts/SystemActions";
import { I18nProvider } from "./i18n";
import { exposePluginSDK } from "./plugins";
import { ThemeProvider } from "./themes";
import { HERMES_BASE_PATH } from "./lib/api";
import { selectHoloTransport } from "./lib/holo-bootstrap";
import HoloStaticShell from "./components/HoloStaticShell";

// Select the dashboard transport before anything renders or fetches: hologram (in-guest web_server
// over the emulator loopback bridge), static (no-backend Pages shell), or origin (server-hosted — the
// default when the holospace launcher injects no signal). A no-op for a normal server-hosted build.
// The chosen mode is exposed on window for the browser e2e gate (vv/e2e) — harmless in production.
const __holoTransportMode = selectHoloTransport();
if (typeof window !== "undefined")
  (window as Window & { __HERMES_TRANSPORT_MODE__?: string }).__HERMES_TRANSPORT_MODE__ =
    __holoTransportMode;

const root = createRoot(document.getElementById("root")!);

if (__holoTransportMode === "static") {
  // No-backend Pages shell: the data-driven dashboard needs a backend, so render the self-contained
  // static landing instead of the routed app (no providers, no /api fetches → never white-screens).
  root.render(<HoloStaticShell />);
} else {
  // Expose the plugin SDK before rendering so plugins loaded via <script>
  // can access React, components, etc. immediately.
  exposePluginSDK();

  root.render(
    <BrowserRouter basename={HERMES_BASE_PATH || undefined}>
      <I18nProvider>
        <ThemeProvider>
          <SystemActionsProvider>
            <App />
          </SystemActionsProvider>
        </ThemeProvider>
      </I18nProvider>
    </BrowserRouter>,
  );
}
