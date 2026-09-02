import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3417";

/**
 * Isolated browser QA for telephony controls.
 *
 * The repository's normal `.env.local` points at live services. Explicit empty
 * process variables take precedence over Next's dotenv loading, so the server
 * renders the built-in mock data and cannot construct a Supabase admin or
 * VIPTel client. The spec adds a second browser-side mutation firewall.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "viptel-telephony-ui.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/playwright-telephony-ui",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3417",
    env: {
      MOTORIST_DEV_AUTH_BYPASS: "true",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
      VIPTEL_LIVE_MUTATION_TOKEN: "",
      VIPTEL_PASSWORD: "",
      VIPTEL_REST_BASE_URL: "",
      VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "false",
      VIPTEL_SIP_WEBPHONE_ENABLED: "false",
      VIPTEL_USERNAME: "",
      VIPTEL_WEBPHONE_MOCK_ENABLED: "false",
      VIPTEL_WEBSOCKET_URL: "",
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
});
