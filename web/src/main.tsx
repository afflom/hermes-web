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

// Install the data transport before anything renders or fetches. The static (no-backend) build answers
// every read with well-formed empty state so the real dashboard renders its empty-state UI; a
// server-hosted build talks to the live `/api` backend unchanged. No-op for the server build.
selectHoloTransport();

// Expose the plugin SDK before rendering so plugins loaded via <script> can access React immediately.
exposePluginSDK();

createRoot(document.getElementById("root")!).render(
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
