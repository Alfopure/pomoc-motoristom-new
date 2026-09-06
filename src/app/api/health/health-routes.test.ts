import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getLive } from "./live/route";
import { GET as getReady } from "./ready/route";

const mocks = vi.hoisted(() => ({
  serviceEnv: vi.fn(),
  adminClient: vi.fn(),
  readinessQuery: vi.fn(),
}));

vi.mock("@/lib/supabase/env", () => ({ getSupabaseServiceEnv: mocks.serviceEnv }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.adminClient }));

describe("health release identifiers", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
    vi.stubEnv("DEPLOYMENT_VERSION", "old-manual-version");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "current-commit");
    mocks.serviceEnv.mockReturnValue({});
    mocks.readinessQuery.mockResolvedValue({ error: null });
    mocks.adminClient.mockReturnValue({
      from: () => ({ select: () => ({ abortSignal: mocks.readinessQuery }) }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("returns an uncached deployment version without accessing the database", async () => {
    const response = getLive();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "live", version: "dpl_current" });
    expect(mocks.adminClient).not.toHaveBeenCalled();
    expect(mocks.serviceEnv).not.toHaveBeenCalled();
  });

  it("reads the current deployment on each request", async () => {
    await expect(getLive().json()).resolves.toMatchObject({ version: "dpl_current" });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_next");

    await expect(getLive().json()).resolves.toMatchObject({ version: "dpl_next" });
  });

  it("returns the same uncached release identifier when readiness succeeds", async () => {
    const response = await getReady();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      version: "dpl_current",
      checkedAt: expect.any(String),
    });
  });

  it("retains the uncached release identifier when readiness fails", async () => {
    mocks.readinessQuery.mockResolvedValue({ error: { message: "private database error" } });

    const response = await getReady();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      version: "dpl_current",
      checkedAt: expect.any(String),
    });
  });
});
