import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { TEST_APP_ORIGIN, TEST_SUPABASE_REF, TEST_VERCEL_PROJECT_ID } from "@/lib/app-environment";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { TRANSIENT_READ_RETRY_MS } from "@/server/transient-read";
import { loadActiveCallsCached, readActiveCallRows, resetActiveCallsCache } from "./active-calls";
import { UNOWNED_READ_MS } from "./ownership";

const timeout = { code: "", message: `AbortError: un-owned read exceeded ${UNOWNED_READ_MS} ms`, details: "", hint: "" };
const snapshot = () => ({ sessions: [], legs: [], attempts: [], presence: [], devices: [], lines: [], operatorSettings: [], callRows: [] });
const actor = (profileId: string = PROFILES.o1) => ({ profileId, canManageAssignments: false });

beforeEach(() => {
  resetActiveCallsCache();
  vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "true");
});
afterEach(() => {
  resetActiveCallsCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function untilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Exercise the real PostgREST transport/error conversion, with an entirely
// local fetch function. No database credentials or external requests are used.
function rpcFixture(respond: (attempt: number, signal: AbortSignal) => Response | Promise<Response>) {
  let attempt = 0;
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => respond(++attempt, init!.signal!));
  const admin = createClient<Database>("https://snapshot.test", "fixture", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { fetch, deps: { admin, organizationId: ORG, environment: "development" as const, configured: true, now: () => new Date() } };
}

describe("bounded active-call read recovery", () => {
  it("verifies its own 10 s snapshot timeout with exactly one fresh POST", async () => {
    vi.useFakeTimers();
    const fresh = { ...snapshot(), lines: [{ id: "fresh-line" }] };
    const h = rpcFixture((attempt, signal) => attempt === 1 ? untilAbort(signal) : Response.json(fresh));
    const result = readActiveCallRows(h.deps);
    await vi.advanceTimersByTimeAsync(UNOWNED_READ_MS - 1);
    expect(h.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ lines: [{ id: "fresh-line" }] });
    expect(h.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    expect(h.fetch.mock.calls.every(([url]) => String(url).endsWith("/rest/v1/rpc/motorist_active_call_snapshot_v1"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps persistent failures visible after only one extra second, without table or empty fallback", async () => {
    vi.useFakeTimers();
    const h = rpcFixture((_, signal) => untilAbort(signal));
    const result = expect(readActiveCallRows(h.deps)).rejects.toThrow("active call snapshot failed: AbortError: Read verification exceeded its deadline");
    await vi.advanceTimersByTimeAsync(UNOWNED_READ_MS + TRANSIENT_READ_RETRY_MS);
    await result;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["42501", "PGRST202"])("does not retry permission/installation failure %s", async code => {
    const h = rpcFixture(() => Response.json({ code, message: "not allowed or not installed", details: "", hint: "" }, { status: 403 }));
    await expect(readActiveCallRows(h.deps)).rejects.toThrow("not allowed or not installed");
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it.each([null, [], {}, { sessions: [] }])("never retries or substitutes a malformed successful snapshot (%j)", async data => {
    const h = rpcFixture(() => Response.json(data));
    await expect(readActiveCallRows(h.deps)).rejects.toThrow(/active call snapshot/);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("does not reinterpret a caller's abort as its own snapshot deadline", async () => {
    const h = rpcFixture(() => { throw new DOMException("caller cancelled", "AbortError"); });
    await expect(readActiveCallRows(h.deps)).rejects.toThrow("caller cancelled");
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("shares the initial read and verification with concurrent polls beyond the cache interval", async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const verification = new Promise<Response>(resolve => { complete = resolve; });
    const h = rpcFixture((attempt, signal) => attempt === 1 ? untilAbort(signal) : verification);
    const first = loadActiveCallsCached(h.deps, actor());
    await vi.advanceTimersByTimeAsync(UNOWNED_READ_MS);
    const second = loadActiveCallsCached(h.deps, actor(PROFILES.o2));
    const third = loadActiveCallsCached(h.deps, actor(PROFILES.o3));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    complete(Response.json(snapshot()));
    const results = await Promise.all([first, second, third]);
    expect(results.map(result => result.actorProfileId)).toEqual([PROFILES.o1, PROFILES.o2, PROFILES.o3]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not serve a previous successful snapshot when a later verified read still fails", async () => {
    vi.useFakeTimers();
    const h = rpcFixture((attempt, signal) => attempt === 1 ? Response.json(snapshot()) : untilAbort(signal));
    await loadActiveCallsCached(h.deps, actor());
    await vi.advanceTimersByTimeAsync(1_001);
    const result = expect(loadActiveCallsCached(h.deps, actor())).rejects.toThrow("Read verification exceeded its deadline");
    await vi.advanceTimersByTimeAsync(UNOWNED_READ_MS + TRANSIENT_READ_RETRY_MS);
    await result;
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["motorist_operator_presence", "motorist_operator_devices", "motorist_telephony_lines"])("recovers a transient %s read without repeating other compatibility reads", async table => {
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    h.db.failNext(table, "select", timeout);
    await expect(readActiveCallRows({ ...h.deps, configured: true })).resolves.toBeDefined();
    expect(h.db.log.filter(entry => entry.table === table && entry.operation === "select")).toHaveLength(2);
    expect(h.db.log.filter(entry => entry.table === "motorist_call_sessions" && entry.operation === "select")).toHaveLength(1);
    expect(h.db.log.every(entry => entry.operation === "select")).toBe(true);
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it("shares one verification allowance between simultaneous failing compatibility reads", async () => {
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    h.db.failNext("motorist_operator_presence", "select", timeout);
    h.db.failNext("motorist_operator_devices", "select", timeout);
    await expect(readActiveCallRows({ ...h.deps, configured: true })).rejects.toThrow(/load failed/);
    expect(h.db.log.filter(entry => entry.operation === "select")).toHaveLength(6);
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it("does not give the native device read a separate retry allowance", async () => {
    for (const [name, value] of Object.entries({
      MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: TEST_VERCEL_PROJECT_ID,
      APP_BASE_URL: TEST_APP_ORIGIN, SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`, MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true",
    })) vi.stubEnv(name, value);
    const h = createTelephonyHarness();
    const signal = vi.fn()
      .mockResolvedValueOnce({ data: null, error: timeout })
      .mockResolvedValueOnce({ data: snapshot(), error: null });
    vi.spyOn(h.admin, "rpc").mockReturnValue({ abortSignal: signal } as unknown as ReturnType<typeof h.admin.rpc>);
    h.db.failNext("motorist_operator_mobile_devices", "select", timeout);
    await expect(readActiveCallRows({ ...h.deps, configured: true })).rejects.toThrow("mobile devices load failed");
    expect(signal).toHaveBeenCalledTimes(2);
    expect(h.db.log.filter(entry => entry.table === "motorist_operator_mobile_devices")).toHaveLength(1);
    expect(h.telnyx.calls).toHaveLength(0);
  });
});
