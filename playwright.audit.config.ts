import { defineConfig, devices } from "@playwright/test";
import chromium from "@sparticuz/chromium";

/** Offline fixtures exercise the shipped browser modules. No application/provider credentials. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["diagnostic-errors.spec.ts", "startup-diagnostics.spec.ts", "telephony-quality-diagnostics.spec.ts", "recording-playback.spec.ts", "recording-policy.spec.ts", "call-journey.spec.ts"],
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: "list",
  outputDir: "test-results/audit",
  use: {
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.DIAGNOSTICS_CHROMIUM_PATH,
      // Playwright creates/tears down a context per test; single-process mode
      // exits the whole serverless browser when the first context closes.
      args: process.env.DIAGNOSTICS_SERVERLESS_CHROMIUM === "1" ? chromium.args.filter(arg => arg !== "--single-process" && arg !== "--disable-web-security") : [],
    },
  },
});
