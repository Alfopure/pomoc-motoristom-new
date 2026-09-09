import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      TRACKER_LOCAL_FILE: "/tmp/motorist-testovanie-e2e.json",
      TRACKER_SESSION_SECRET:
        "local-e2e-only-session-secret-at-least-32-characters",
    },
  },
});
