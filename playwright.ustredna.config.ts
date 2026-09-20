import { defineConfig } from "@playwright/test";

/** Isolated component/API fixtures: no app credentials, server or provider calls. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["ustredna-workspace.spec.ts", "operator-team.spec.ts", "ustredna-accessibility.spec.ts", "call-tray.spec.ts", "incoming-routing.spec.ts", "case-collaboration.spec.ts", "history-authorization.spec.ts", "callback-shared.spec.ts"],
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: ".context/ustredna-playwright",
  use: {
    headless: true,
    serviceWorkers: "block",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ["--no-sandbox"],
    },
  },
});
