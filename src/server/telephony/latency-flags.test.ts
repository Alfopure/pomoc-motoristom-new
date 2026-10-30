import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { callColleague, createRateLimiter, startOutboundCall } from "./call-actions";
import {
  clearLatencyFlagsCache, concurrentDialFor, defaultLatencyFlags, envLatencyFlags, freezeStartMode, LATENCY_FLAGS_CACHE_TTL_MS,
  mobileVoiceTuning, readLatencyFlags, SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, webCallTuning, type LatencyFlags,
} from "./latency-flags";
import { readMeta, type SessionRow } from "./state/types";

const columnMissing = { message: "column motorist_telephony_settings.latency_flags does not exist", code: "42703", details: null, hint: null };

function settings(latencyFlags?: unknown) {
  const fake = createFakeSupabase();
  fake.db.seed("motorist_telephony_settings", [{ organization_id: ORG, live_calls_enabled: true, ...(latencyFlags === undefined ? {} : { latency_flags: latencyFlags }) }]);
  return fake;
}

const reads = (fake: ReturnType<typeof createFakeSupabase>) => fake.db.log.filter(row => row.table === "motorist_telephony_settings").length;

beforeEach(() => clearLatencyFlagsCache());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("latency flags", () => {
  it("defaults every switch to today's behaviour", () => {
    const flags = defaultLatencyFlags();
    expect(Object.entries(flags).filter(([, value]) => typeof value === "boolean" && value)).toEqual([]);
    expect(flags).toMatchObject({ concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: false, mobile: false } },
      own_leg_timeout_secs_concurrent: 12, api_region: "us", http_keepalive_ms: 0 });
    expect(Object.values(flags.client).every(value => value === false || value === "auto")).toBe(true);
    expect(envLatencyFlags({})).toEqual(flags);
  });

  it("reads env alone", () => {
    const flags = envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ internal_lean_path: true, api_region: "eu",
      concurrent_dial: { internal: { web: true } }, own_leg_timeout_secs_concurrent: 15, client: { webEarlyAccept: true } }) });
    expect(flags).toMatchObject({ internal_lean_path: true, api_region: "eu", own_leg_timeout_secs_concurrent: 15,
      concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: true, mobile: false } } });
    expect(webCallTuning(flags)).toEqual({ webEarlyAccept: true, webRtcRegion: "auto", webPrefetchIce: false, targetLocalFirst: false });
  });

  it("lets the database win key by key over env", async () => {
    const fake = settings({ api_region: "us", hold_fast_web: true, concurrent_dial: { internal: { mobile: true } }, client: { mobileTrickleIce: true } });
    const flags = await readLatencyFlags(fake.admin, ORG, { logger: () => {},
      env: { TELEPHONY_LATENCY_FLAGS: JSON.stringify({ api_region: "eu", internal_lean_path: true, concurrent_dial: { internal: { web: true } }, client: { mobileRtcRegion: "eu" } }) } });
    expect(flags).toMatchObject({ api_region: "us", internal_lean_path: true, hold_fast_web: true,
      concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: true, mobile: true } } });
    expect(mobileVoiceTuning(flags)).toMatchObject({ mobileTrickleIce: true, mobileRtcRegion: "eu" });
  });

  it.each([columnMissing, { message: "Could not find the 'latency_flags' column in the schema cache", code: "PGRST204", details: null, hint: null }])(
    "falls back to env when the column is missing ($code), and logs that once per instance", async (missing) => {
    const fake = settings();
    const logger = vi.fn();
    const env = { TELEPHONY_LATENCY_FLAGS: JSON.stringify({ hold_fast_web: true }) };
    vi.useFakeTimers();
    for (let round = 0; round < 3; round += 1) {
      fake.db.failNext("motorist_telephony_settings", "select", missing);
      expect(await readLatencyFlags(fake.admin, ORG, { env, logger })).toMatchObject({ hold_fast_web: true, internal_lean_path: false });
      vi.advanceTimersByTime(LATENCY_FLAGS_CACHE_TTL_MS);
    }
    expect(logger.mock.calls.filter(([entry]) => entry.problem === "database:column_missing")).toHaveLength(1);
    // The effective set is logged once, not on every refresh.
    expect(logger.mock.calls.filter(([entry]) => entry.scope === "latency-flags" && entry.flags)).toHaveLength(1);
  });

  it("keeps the defaults for invalid env JSON and ignores unknown keys and wrong types", async () => {
    const logger = vi.fn();
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: "{not json" }, logger)).toEqual(defaultLatencyFlags());
    const fake = settings({ internal_lean_path: "yes", surprise: true, own_leg_timeout_secs_concurrent: 40, api_region: "asia",
      http_keepalive_ms: -1, concurrent_dial: { inbound: { web: true }, outbound: { tablet: true, web: 1 } }, client: { webRtcRegion: "mars", other: true } });
    expect(await readLatencyFlags(fake.admin, ORG, { logger, env: {} })).toEqual(defaultLatencyFlags());
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: "{not json" }, logger)).toEqual(defaultLatencyFlags());
    const problems = logger.mock.calls.map(([entry]) => entry.problem).filter(Boolean);
    expect(problems).toEqual(["env:invalid_json", "database:internal_lean_path", "database:surprise", "database:own_leg_timeout_secs_concurrent",
      "database:api_region", "database:http_keepalive_ms", "database:concurrent_dial.inbound", "database:concurrent_dial.outbound.tablet",
      "database:concurrent_dial.outbound.web", "database:client.webRtcRegion", "database:client.other"]);
    // Key names only: no value reaches the log.
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/mars|asia|yes/);
  });

  it("reuses a read for the TTL and then sees a database change", async () => {
    const fake = settings({ hold_fast_web: true });
    vi.useFakeTimers();
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env: {} })).hold_fast_web).toBe(true);
    fake.db.update("motorist_telephony_settings", { latency_flags: { hold_fast_web: false } }, () => true);
    vi.advanceTimersByTime(LATENCY_FLAGS_CACHE_TTL_MS - 1);
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env: {} })).hold_fast_web).toBe(true);
    expect(reads(fake)).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env: {} })).hold_fast_web).toBe(false);
    expect(reads(fake)).toBe(2);
  });

  it("does not reuse a failed read", async () => {
    const fake = settings({ hold_fast_web: true });
    fake.db.failNext("motorist_telephony_settings", "select", "connection reset");
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env: {} })).hold_fast_web).toBe(false);
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env: {} })).hold_fast_web).toBe(true);
    expect(reads(fake)).toBe(2);
  });

  it("resolves concurrent dialing by direction and origin device", () => {
    const flags: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: { outbound: { web: true, mobile: false }, internal: { web: false, mobile: true } },
      own_leg_timeout_secs_concurrent: 9, internal_auto_bridge: true, api_region: "eu" };
    expect([concurrentDialFor(flags, "outbound", "web"), concurrentDialFor(flags, "outbound", "mobile"),
      concurrentDialFor(flags, "internal", "web"), concurrentDialFor(flags, "internal", "mobile")]).toEqual([true, false, false, true]);
    expect(freezeStartMode(flags, { direction: "outbound", origin: "web" })).toEqual({ concurrent: true, autoBridge: false, ownLegTimeoutSecs: 9, apiRegion: "eu", origin: "web" });
    expect(freezeStartMode(flags, { direction: "outbound", origin: "mobile" })).toEqual({ concurrent: false, autoBridge: false,
      ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, apiRegion: "eu", origin: "mobile" });
    expect(freezeStartMode(flags, { direction: "internal", origin: "mobile" })).toMatchObject({ concurrent: true, autoBridge: true, ownLegTimeoutSecs: 9 });
    expect(freezeStartMode(flags, { direction: "inbound", origin: null })).toEqual({ concurrent: false, autoBridge: false,
      ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, apiRegion: "eu", origin: null });
  });

  it("freezes the start mode into every new session, and a later flip leaves it alone", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    const concurrent: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: { outbound: { web: true, mobile: false }, internal: { web: true, mobile: false } } };
    const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }), latencyFlags: concurrent };
    const first = await startOutboundCall(deps, { profileId: PROFILES.o1, role: "dispatcher" }, { to: NUMBERS.customer });
    const startMode = (sessionId: string) => readMeta(h.session(sessionId) as SessionRow).start_mode;
    expect(startMode(first.sessionId)).toEqual({ concurrent: true, autoBridge: false, ownLegTimeoutSecs: 12, apiRegion: "us", origin: "web" });

    deps.latencyFlags = defaultLatencyFlags();
    h.telnyx.physical.answered(first.operatorLegCallControlId);
    await h.legEvent(first.operatorLegCallControlId, "call.answered");
    expect(startMode(first.sessionId)).toMatchObject({ concurrent: true });
    const second = await callColleague(deps, { profileId: PROFILES.o2, role: "dispatcher" }, { targetProfileId: PROFILES.o5 });
    expect(startMode(second.sessionId)).toEqual({ concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "us", origin: "web" });

    const inbound = await h.inbound({ to: NUMBERS.allianz, answer: false });
    expect(startMode(inbound.sessionId)).toEqual({ concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "us", origin: null });
  });
});
