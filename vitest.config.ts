import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests model deployment identity explicitly. Hosted CI variables must not
// become their baseline: unstubAllEnvs restores that baseline, including during
// a test. test.env is applied in workers before application modules are imported.
// Leave NODE_ENV, PATH and other runner/runtime settings untouched.
const neutralEnvironmentKeys = new Set([
  "VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_GIT_COMMIT_REF", "MOTORIST_APP_ENV",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_PROJECT_REF", "EXPECTED_SUPABASE_PROJECT_REF",
  "APP_BASE_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_APP_URL",
  "MOTORIST_TEST_LIVE_INTEGRATIONS", "MOTORIST_TEST_ALLOWED_NUMBERS", "MOTORIST_TEST_FROM_NUMBERS",
  "MOTORIST_TEST_ALLOWED_EMAILS", "MOTORIST_TEST_SMS_ALPHA_SENDER",
  // Also withhold inherited provider and monitoring keys/switches. Fixtures opt
  // in using fake values; adding a CI variable must not turn a unit test live.
  ...Object.keys(process.env).filter(key =>
    /^(VERCEL_|MOTORIST_|SUPABASE_|NEXT_PUBLIC_SUPABASE_|TELNYX_|OPENAI_|AI_DEMO_|EMAIL_|RESEND_|ELEVENLABS_|GOOGLE_MAPS_|NEXT_PUBLIC_GOOGLE_MAPS_|COMMANDER_|WEBDISPECINK_|SWHOUSE_|DATABAZA_VOZIDIEL_|DIAGNOSTICS_|NEXT_PUBLIC_DIAGNOSTICS_)/.test(key)),
]);

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    env: Object.fromEntries([...neutralEnvironmentKeys].map(key => [key, ""])),
    exclude: ["tests/**/*.test.mjs", "e2e/**", ".context/**", "apps/**", "**/node_modules/**", "**/.next/**"],
  },
});
