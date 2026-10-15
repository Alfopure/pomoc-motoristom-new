import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getLive } from "./live/route";
import { GET as getReady } from "./ready/route";

const mocks = vi.hoisted(() => ({
  serviceEnv: vi.fn(),
  adminClient: vi.fn(),
  readinessQuery: vi.fn(),
  cronReady: vi.fn(),
}));

vi.mock("@/lib/supabase/env", () => ({ getSupabaseServiceEnv: mocks.serviceEnv }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.adminClient }));
vi.mock("@/server/diagnostics/cron-heartbeat", () => ({ cronHeartbeatReadiness: mocks.cronReady }));

describe("health release identifiers", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
    vi.stubEnv("DEPLOYMENT_VERSION", "old-manual-version");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "current-commit");
    mocks.serviceEnv.mockReturnValue({});
    mocks.readinessQuery.mockResolvedValue({ error: null });
    mocks.cronReady.mockResolvedValue({ ready: true, reason: "ok" });
    mocks.adminClient.mockReturnValue({
      from: () => ({ select: () => ({ abortSignal: mocks.readinessQuery }) }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("returns an uncached deployment version without accessing the database", async () => {
    const response = getLive();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "live", version: "dpl_current", release: {
      environment: "development", code: null, builtAt: null, commit: "current-commit", deployment: "dpl_current",
    } });
    expect(mocks.adminClient).not.toHaveBeenCalled();
    expect(mocks.serviceEnv).not.toHaveBeenCalled();
    expect(mocks.cronReady).not.toHaveBeenCalled();
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

  it("returns generic 503 for an unhealthy cron even when the web/database are reachable", async () => {
    mocks.cronReady.mockResolvedValue({ ready: false, reason: "critical_jobs_failed" });
    const response = await getReady();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "not_ready", version: "dpl_current", checkedAt: expect.any(String) });
    expect(mocks.cronReady).toHaveBeenCalledWith(mocks.adminClient.mock.results[0].value);
  });


  it("logs safe reasons while keeping the public failure generic", async () => {
    mocks.readinessQuery.mockResolvedValue({ error: { message: "private SQL token" } });
    mocks.cronReady.mockResolvedValue({ ready: false, reason: "heartbeat_stale" });
    const response = await getReady();
    expect(response.status).toBe(503);
    const logged = JSON.parse(vi.mocked(console.warn).mock.calls.at(-1)![0]);
    expect(logged).toMatchObject({ scope: "application-readiness", reason: "dependency_unavailable", database: "database_unavailable", cron: "heartbeat_stale" });
    expect(JSON.stringify(logged)).not.toContain("private");
    expect(await response.text()).not.toMatch(/heartbeat_stale|database_unavailable|private/);
  });

  it("remains ready for a completed cron with only auxiliary degradation", async () => {
    mocks.cronReady.mockResolvedValue({ ready: true, reason: "auxiliary_degraded" });
    expect((await getReady()).status).toBe(200);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("bounds a stalled database transport at three seconds and aborts it", async () => {
    vi.useFakeTimers();
    mocks.readinessQuery.mockImplementation(() => new Promise(() => {}));
    const response = getReady();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await response).status).toBe(503);
    expect(mocks.readinessQuery.mock.calls[0][0].aborted).toBe(true);
    expect(JSON.parse(vi.mocked(console.warn).mock.calls.at(-1)![0])).toMatchObject({ database: "database_timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains an unexpected heartbeat exception without exposing internal state", async () => {
    mocks.cronReady.mockRejectedValue(new Error("private heartbeat marker"));
    const response = await getReady();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "not_ready", version: "dpl_current", checkedAt: expect.any(String) });
  });
});
