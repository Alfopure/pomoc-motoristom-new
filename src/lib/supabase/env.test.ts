import { afterEach, describe, expect, it, vi } from "vitest";

import { getSupabaseServiceEnv, selectServiceKey } from "./env";

const legacy = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service";
const secret = "sb_secret_example";

describe("server key selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the legacy service_role JWT, which the gateway does not re-mint per request", () => {
    expect(selectServiceKey({ SUPABASE_SECRET_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: legacy })).toBe(legacy);
  });

  it("uses the secret key when no JWT key is configured", () => {
    expect(selectServiceKey({ SUPABASE_SECRET_KEY: secret })).toBe(secret);
    expect(selectServiceKey({ SUPABASE_SECRET_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_other" })).toBe(secret);
  });

  it("falls back to a non-JWT service_role value only when nothing else exists", () => {
    expect(selectServiceKey({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_only" })).toBe("sb_secret_only");
  });

  it("restores the secret-first order when asked to", () => {
    expect(selectServiceKey({ SUPABASE_SECRET_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: legacy, SUPABASE_PREFER_SECRET_KEY: "true" })).toBe(secret);
  });

  it("keeps signing with the key the application always signed with", () => {
    vi.stubEnv("SUPABASE_URL", "https://isolated.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_example");
    vi.stubEnv("SUPABASE_SECRET_KEY", secret);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", legacy);
    expect(getSupabaseServiceEnv()).toMatchObject({ serviceKey: legacy, signingSecret: secret });
  });
});
