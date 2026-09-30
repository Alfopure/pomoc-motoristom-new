import { afterEach, expect, it, vi } from "vitest";
import { canOperateTelephony, resolveAppEnvironment } from "@/lib/app-environment";

const identityKeys = ["VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_GIT_COMMIT_REF", "MOTORIST_APP_ENV",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_PROJECT_REF", "EXPECTED_SUPABASE_PROJECT_REF",
  "APP_BASE_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_APP_URL", "MOTORIST_TEST_LIVE_INTEGRATIONS"];

afterEach(() => vi.unstubAllEnvs());

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
