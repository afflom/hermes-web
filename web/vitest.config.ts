import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import path from "path";

// Two projects:
//   node    — the existing dashboard unit tests (pure logic).
//   browser — the holospaces implementation parts run in a REAL Chromium (vitest browser mode), so the
//             transport, egress, base-mapping, and the content-addressed warm-κ codec (which uses
//             DecompressionStream / crypto.subtle / OPFS) are evaluated in the browser runtime they
//             actually ship to — not a node shim. Files: src/**/*.browser.test.ts.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}", "node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
