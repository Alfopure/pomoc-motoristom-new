import { afterEach, expect, it, vi } from "vitest";
import { canOperateTelephony, resolveAppEnvironment } from "@/lib/app-environment";
import { telephonyStabilityEnabled } from "@/server/telephony/stability";

const identityKeys = ["VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_GIT_COMMIT_REF", "MOTORIST_APP_ENV",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_PROJECT_REF", "EXPECTED_SUPABASE_PROJECT_REF",
  "APP_BASE_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_APP_URL", "MOTORIST_TEST_LIVE_INTEGRATIONS"];

afterEach(() => vi.unstubAllEnvs());

it("keeps hosted telephony flags out of the baseline while allowing explicit stability fixtures", () => {
  expect(telephonyStabilityEnabled()).toBe(false);
  expect(process.env.TELEPHONY_STABILITY_V1_ENABLED).toBe("");

  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  expect(telephonyStabilityEnabled()).toBe(true);
  vi.unstubAllEnvs();

  expect(telephonyStabilityEnabled()).toBe(false);
  expect(process.env.TELEPHONY_STABILITY_V1_ENABLED).toBe("");
});

it("withholds hosted fleet and paid-lookup credentials even after fixture restoration", () => {
  const providerKeys = ["COMMANDER_API_PASSWORD", "WEBDISPECINK_PASSWORD", "WEBDISPECINK_SYNC_ENABLED",
    "SWHOUSE_LOGIN_PASSWORD", "SWHOUSE_SMOKE", "DATABAZA_VOZIDIEL_API_KEY"];
  for (const key of providerKeys) {
    // Absent locally or blanked by the worker configuration when inherited.
    expect(process.env[key] ?? "", key).toBe("");
    vi.stubEnv(key, "synthetic-fixture-value");
    expect(process.env[key], key).toBe("synthetic-fixture-value");
  }
  vi.unstubAllEnvs();
  for (const key of providerKeys) expect(process.env[key] ?? "", key).toBe("");
});

it("withholds hosted monitoring switches and transport after fixture restoration", () => {
  const monitorKeys = ["DIAGNOSTICS_ENABLED", "DIAGNOSTICS_PANEL_ENABLED", "DIAGNOSTICS_CLASSIFIER_ENABLED",
    "DIAGNOSTICS_PHYSICAL_BUDGET_BYTES", "NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN", "NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID"];
  for (const key of monitorKeys) {
    expect(process.env[key] ?? "", key).toBe("");
    vi.stubEnv(key, "synthetic-monitor-fixture");
  }
  vi.unstubAllEnvs();
  for (const key of monitorKeys) expect(process.env[key] ?? "", key).toBe("");
});

it("starts neutral and restores that worker baseline after explicit deployment stubs", () => {
  const nodeEnv = process.env.NODE_ENV;
  expect(nodeEnv).toBeTruthy();
  for (const key of identityKeys) expect(process.env[key], key).toBe("");
  expect(resolveAppEnvironment()).toBe("development");

  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("MOTORIST_APP_ENV", "test");
  expect(canOperateTelephony()).toBe(false); // Actual runtime guard stays active.
  vi.unstubAllEnvs();

  for (const key of identityKeys) expect(process.env[key], key).toBe("");
  expect(resolveAppEnvironment()).toBe("development");
  expect(process.env.NODE_ENV).toBe(nodeEnv);
});
