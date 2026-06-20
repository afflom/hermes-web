import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { SystemActionsProvider } from "./contexts/SystemActions";
import { I18nProvider } from "./i18n";
import { exposePluginSDK } from "./plugins";
import { ThemeProvider } from "./themes";
import { HERMES_BASE_PATH } from "./lib/api";
import { selectTransportMode } from "./lib/holo-bootstrap";
import { HologramBoot } from "./components/HologramBoot";

// Decide the data transport before rendering. On the Pages build this is `hologram` — the real Hermes
// backend runs in an in-browser holospaces RISC-V guest and must be RESUMED (and the loopback transport
// installed) before the app fires its first /api call, so `HologramBoot` gates the app on that boot. A
// server-hosted build is `origin` (the default HTTP-to-/api transport) and renders immediately.
const mode = selectTransportMode();

// Expose the plugin SDK before rendering so plugins loaded via <script> can access React immediately.
exposePluginSDK();

const tree = (
  <BrowserRouter basename={HERMES_BASE_PATH || undefined}>
    <I18nProvider>
      <ThemeProvider>
        <SystemActionsProvider>
          <App />
        </SystemActionsProvider>
      </ThemeProvider>
    </I18nProvider>
  </BrowserRouter>
);

createRoot(document.getElementById("root")!).render(
  mode === "hologram" ? <HologramBoot>{tree}</HologramBoot> : tree,
);
