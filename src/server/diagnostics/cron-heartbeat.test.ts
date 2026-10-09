import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cronHeartbeatConfiguration, cronHeartbeatReady, CRON_HEARTBEAT_LIMITS, recordCronHeartbeat } from "./cron-heartbeat";

const NOW = Date.parse("2026-10-06T20:00:00Z");
const RELEASE = "a".repeat(40);
const INSTANCE = "dispatch-cron:test:prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk";
const TEST_ENV: Record<string, string | undefined> = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", VERCEL_GIT_COMMIT_SHA: RELEASE,
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
  NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
  DIAGNOSTICS_CRON_HEARTBEAT_ENABLED: "true", DIAGNOSTICS_CRON_READINESS_ENABLED: "true",
};
const iso = (time: number) => new Date(time).toISOString();
const healthy = () => ({ instance_id: INSTANCE, deployment_version: RELEASE, scheduler_tick_at: iso(NOW - 2_000),
  heartbeat_at: iso(NOW - 1_000), updated_at: iso(NOW - 1_000), scheduler_status: "ok" });
const read = vi.fn();
const write = vi.fn();
const eq = vi.fn();
const select = vi.fn();
const upsert = vi.fn();
const from = vi.fn();
const admin = { from } as unknown as Parameters<typeof recordCronHeartbeat>[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  read.mockReset().mockResolvedValue({ data: healthy(), error: null });
  write.mockReset().mockResolvedValue({ error: null });
  eq.mockReset().mockReturnValue({ abortSignal: (signal: AbortSignal) => ({ maybeSingle: () => read(signal) }) });
  select.mockReset().mockReturnValue({ eq });
  upsert.mockReset().mockReturnValue({ abortSignal: write });
  from.mockReset().mockReturnValue({ select, upsert });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("stable deployment cron completion boundary", () => {
  it("identifies dedicated TEST without any Sentry dependency", () => {
    expect(cronHeartbeatConfiguration(TEST_ENV)).toEqual({ instanceId: INSTANCE, release: RELEASE });
  });

  it("identifies production by its exact project, main branch, origin and database", () => {
    const env = { ...TEST_ENV, MOTORIST_APP_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", APP_BASE_URL: "https://dispecing.linkapomoci.sk",
      SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co", NEXT_PUBLIC_SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" };
    expect(cronHeartbeatConfiguration(env)).toEqual({ instanceId: "dispatch-cron:production:prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", release: RELEASE });
    expect(cronHeartbeatConfiguration({ ...env, VERCEL_GIT_COMMIT_REF: "dev" })).toBeNull();
    expect(cronHeartbeatConfiguration({ ...env, VERCEL_PROJECT_ID: TEST_ENV.VERCEL_PROJECT_ID })).toBeNull();
    expect(cronHeartbeatConfiguration({ ...env, APP_BASE_URL: TEST_ENV.APP_BASE_URL })).toBeNull();
    expect(cronHeartbeatConfiguration({ ...env, SUPABASE_URL: TEST_ENV.SUPABASE_URL })).toBeNull();
  });

  it.each([
    { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: undefined },
    { MOTORIST_APP_ENV: "development" }, { MOTORIST_APP_ENV: undefined }, { MOTORIST_APP_ENV: "invalid" },
    { VERCEL_GIT_COMMIT_REF: "feature" }, { VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG" }, { VERCEL_PROJECT_ID: undefined },
    { APP_BASE_URL: "https://dispecing-test.vercel.app" }, { VERCEL_GIT_COMMIT_SHA: undefined },
    { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://sjcsrygkkmersoczpunh.supabase.co" },
    { EXPECTED_SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn" },
    { SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_URL: undefined },
  ])("refuses foreign/missing configuration %j without a database operation", async mismatch => {
    const env = { ...TEST_ENV, ...mismatch };
    expect(cronHeartbeatConfiguration(env)).toBeNull();
    expect(await recordCronHeartbeat(admin, NOW - 1_000, "ok", env)).toBe(false);
    expect(await cronHeartbeatReady(admin, env)).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it("does no work unless the separate writer/readiness switches opt in", async () => {
    expect(await recordCronHeartbeat(admin, NOW, "ok", {})).toBe(false);
    expect(await cronHeartbeatReady(admin, {})).toBe(true);
    expect(await cronHeartbeatReady(admin, { ...TEST_ENV, DIAGNOSTICS_CRON_HEARTBEAT_ENABLED: "false" })).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("bounded durable completion marker", () => {
  it.each(["ok", "degraded", "failed"] as const)("records completed %s execution in one isolated row", async status => {
    expect(await recordCronHeartbeat(admin, NOW - 2_000, status, TEST_ENV)).toBe(true);
    expect(from).toHaveBeenCalledExactlyOnceWith("motorist_worker_status");
    expect(upsert).toHaveBeenCalledExactlyOnceWith({ instance_id: INSTANCE, deployment_version: RELEASE,
      heartbeat_at: iso(NOW), scheduler_tick_at: iso(NOW - 2_000), scheduler_status: status, updated_at: iso(NOW) }, { onConflict: "instance_id" });
    expect(write).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, NOW + 1, NOW - CRON_HEARTBEAT_LIMITS.maxRuntimeMs - 1])("does not record an invalid start %s", async started => {
    expect(await recordCronHeartbeat(admin, started, "ok", TEST_ENV)).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["response", "throw"])("contains a database %s without exposing its payload", async mode => {
    const secret = "private response/customer/token";
    if (mode === "throw") write.mockRejectedValue(new Error(secret));
    else write.mockResolvedValue({ error: { message: secret } });
    expect(await recordCronHeartbeat(admin, NOW, "ok", TEST_ENV)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('{"scope":"telephony-cron-heartbeat","status":"unconfirmed"}');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
  });

  it("aborts a stalled write after one second with no retry or detached worker", async () => {
    write.mockImplementation(() => new Promise(() => {}));
    const pending = recordCronHeartbeat(admin, NOW, "ok", TEST_ENV);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readiness of the completed existing cron", () => {
  it("reads only its primary key and accepts a fresh success from the previous release", async () => {
    read.mockResolvedValue({ data: { ...healthy(), deployment_version: "b".repeat(40) }, error: null });
    expect(await cronHeartbeatReady(admin, TEST_ENV)).toBe(true);
    expect(from).toHaveBeenCalledExactlyOnceWith("motorist_worker_status");
    expect(eq).toHaveBeenCalledExactlyOnceWith("instance_id", INSTANCE);
    expect(select).toHaveBeenCalledExactlyOnceWith("instance_id,deployment_version,heartbeat_at,scheduler_tick_at,scheduler_status,updated_at");
    expect(upsert).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { scheduler_status: "degraded" }, { scheduler_status: "failed" }, { scheduler_status: "running" },
    { instance_id: "other-worker" }, { deployment_version: "" }, { scheduler_tick_at: null },
    { scheduler_tick_at: "invalid" }, { heartbeat_at: "invalid" }, { updated_at: "invalid" },
    { heartbeat_at: iso(NOW + 1), updated_at: iso(NOW + 1) },
    { scheduler_tick_at: iso(NOW) }, { updated_at: iso(NOW) },
    { scheduler_tick_at: iso(NOW - CRON_HEARTBEAT_LIMITS.maxRuntimeMs - 1_001) },
  ])("fails closed for an invalid or failed completion %j", async difference => {
    read.mockResolvedValue({ data: { ...healthy(), ...difference }, error: null });
    expect(await cronHeartbeatReady(admin, TEST_ENV)).toBe(false);
  });

  it("expires a last success after ten minutes even while the web/database remain accessible", async () => {
    const ended = NOW - CRON_HEARTBEAT_LIMITS.maxAgeMs;
    read.mockResolvedValue({ data: { ...healthy(), scheduler_tick_at: iso(ended - 2_000), heartbeat_at: iso(ended), updated_at: iso(ended) }, error: null });
    expect(await cronHeartbeatReady(admin, TEST_ENV)).toBe(true);
    vi.setSystemTime(NOW + 1);
    expect(await cronHeartbeatReady(admin, TEST_ENV)).toBe(false);
  });

  it.each(["absent", "error", "throw"])("fails closed when completion lookup is %s", async mode => {
    if (mode === "throw") read.mockRejectedValue(new Error("private database error"));
    else read.mockResolvedValue({ data: mode === "absent" ? null : healthy(), error: mode === "error" ? { message: "private database error" } : null });
    expect(await cronHeartbeatReady(admin, TEST_ENV)).toBe(false);
  });

  it("aborts a stalled completion lookup and returns unready within one second", async () => {
    read.mockImplementation(() => new Promise(() => {}));
    const pending = cronHeartbeatReady(admin, TEST_ENV);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
