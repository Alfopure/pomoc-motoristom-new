import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

/** Isolated synthetic UI harnesses; no dev server, auth bypass or live provider. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["towing-ui.spec.ts", "towing-offline-ui.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: ".context/towing-ui-results",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : undefined,
  },
});
