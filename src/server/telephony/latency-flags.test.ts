import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { callColleague, createRateLimiter, startOutboundCall } from "./call-actions";
import {
  clearLatencyFlagsCache, concurrentDialFor, defaultLatencyFlags, envLatencyFlags, freezeStartMode, LATENCY_FLAGS_CACHE_TTL_MS,
  latencyFlagsOf, mobileVoiceTuning, providerRegionOf, readLatencyFlags, SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, webCallTuning, type LatencyFlags,
} from "./latency-flags";
import { getTelnyxConfig } from "./telnyx/env";
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
    // The one switch whose today is `true`: the concurrent far dial links to the own leg (S6 B′ turns it off).
    expect(Object.entries(flags).filter(([, value]) => typeof value === "boolean" && value)).toEqual([["concurrent_far_link_to", true]]);
    expect(flags).toMatchObject({ concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: false, mobile: false } },
      own_leg_timeout_secs_concurrent: 12, api_region: "us", http_keepalive_ms: 0 });
    expect(Object.values(flags.client).every(value => value === false || value === "auto")).toBe(true);
    expect(envLatencyFlags({})).toEqual(flags);
  });

  it("lets the phone cache its JWT only while both mobile credential rotations are on (S8.1)", () => {
    const tuning = (flags: Record<string, unknown>) => mobileVoiceTuning(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify(flags) }));
    expect(defaultLatencyFlags()).toMatchObject({ mobile_rotate_on_takeover: false, mobile_rotate_on_deactivation: false });
    expect(tuning({ client: { mobileTokenCache: true } }).mobileTokenCache).toBe(false);
    expect(tuning({ client: { mobileTokenCache: true }, mobile_rotate_on_takeover: true }).mobileTokenCache).toBe(false);
    expect(tuning({ client: { mobileTokenCache: true }, mobile_rotate_on_deactivation: true }).mobileTokenCache).toBe(false);
    expect(tuning({ client: { mobileTokenCache: true }, mobile_rotate_on_takeover: true, mobile_rotate_on_deactivation: true }).mobileTokenCache).toBe(true);
    expect(tuning({ mobile_rotate_on_takeover: true, mobile_rotate_on_deactivation: true }).mobileTokenCache).toBe(false);
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

  it("resolves concurrent dialing by direction and origin, but freezes only what this build honours", () => {
    const flags: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: { outbound: { web: true, mobile: false }, internal: { web: false, mobile: true } },
      own_leg_timeout_secs_concurrent: 9, internal_auto_bridge: true, api_region: "eu" };
    expect([concurrentDialFor(flags, "outbound", "web"), concurrentDialFor(flags, "outbound", "mobile"),
      concurrentDialFor(flags, "internal", "web"), concurrentDialFor(flags, "internal", "mobile")]).toEqual([true, false, false, true]);
    // S6 ships concurrent dialing with its own-leg timeout and the colleague auto-bridge, frozen on TEST
    // only until its spikes pass (gate below); the API region (S5) is checked separately, below.
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const s6: LatencyFlags = { ...flags, api_region: "us" };
    expect(freezeStartMode(s6, { direction: "outbound", origin: "web", providerRegion: "us" })).toEqual({ concurrent: true, autoBridge: false,
      ownLegTimeoutSecs: 9, apiRegion: "us", origin: "web" });
    expect(freezeStartMode(s6, { direction: "internal", origin: "mobile", providerRegion: "us" })).toEqual({ concurrent: true, autoBridge: true,
      ownLegTimeoutSecs: 9, apiRegion: "us", origin: "mobile" });
    // Per origin: the switch for outbound web says nothing about a colleague call from the web or a call from the phone.
    for (const [direction, origin] of [["outbound", "mobile"], ["internal", "web"], ["inbound", null]] as const) {
      expect(freezeStartMode(s6, { direction, origin, providerRegion: "us" })).toEqual({ concurrent: false, autoBridge: direction === "internal",
        ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, apiRegion: "us", origin });
    }
    // A start that cannot run concurrently (a callback, start announcements) freezes the sequential dial.
    expect(freezeStartMode(s6, { direction: "outbound", origin: "web", providerRegion: "us", concurrentEligible: false }))
      .toMatchObject({ concurrent: false, ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS });
    // A colleague with several endpoints keeps the server's explicit bridge: only one endpoint may be auto-bridged.
    expect(freezeStartMode(s6, { direction: "internal", origin: "mobile", providerRegion: "us", autoBridgeEligible: false }))
      .toMatchObject({ concurrent: true, autoBridge: false });
    // S7b ships its behaviour: join-with-hold is frozen when asked for, and only then; never for a colleague call.
    const joinHeld = { ...s6, hold_join_with_hold: true };
    expect(freezeStartMode(joinHeld, { direction: "inbound", origin: null, providerRegion: "us" })).toMatchObject({ holdJoinWithHold: true });
    expect(freezeStartMode(joinHeld, { direction: "outbound", origin: "mobile", providerRegion: "us" })).toMatchObject({ holdJoinWithHold: true });
    expect(freezeStartMode(joinHeld, { direction: "internal", origin: "web", providerRegion: "us" })).not.toHaveProperty("holdJoinWithHold");
    // S5 (spike S5.0 passed): on TEST and in production a session we create takes the flag's API region when the
    // start knows it will not be recorded (recording through the EU API is unproven); an inbound call keeps the
    // region its client calls whatever it is told.
    for (const environment of ["test", "production"]) {
      vi.stubEnv("MOTORIST_APP_ENV", environment);
      for (const [direction, origin, apiRegion] of [["outbound", "web", "eu"], ["internal", "mobile", "eu"], ["inbound", null, "us"]] as const) {
        expect(freezeStartMode(flags, { direction, origin, providerRegion: "us", unrecorded: true }).apiRegion, environment).toBe(apiRegion);
        // A call that may be recorded, and a start that did not say, keep `us`.
        for (const unrecorded of [false, undefined]) {
          expect(freezeStartMode(flags, { direction, origin, providerRegion: "us", unrecorded }).apiRegion, `${environment} ${unrecorded}`).toBe("us");
        }
      }
      expect(freezeStartMode({ ...flags, api_region: "us" }, { direction: "outbound", origin: "web", providerRegion: "us", unrecorded: true }).apiRegion).toBe("us");
    }
    // A local run (development, which may point at production data) and an unreadable environment keep `us`.
    for (const environment of ["development", "staging"]) {
      vi.stubEnv("MOTORIST_APP_ENV", environment);
      expect(freezeStartMode(flags, { direction: "outbound", origin: "web", providerRegion: "us", unrecorded: true }).apiRegion, environment).toBe("us");
    }
    vi.unstubAllEnvs();
    vi.stubEnv("MOTORIST_APP_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(freezeStartMode(flags, { direction: "outbound", origin: "web", providerRegion: "us", unrecorded: true }).apiRegion).toBe("us");
    vi.unstubAllEnvs();
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ hold_lean_context: true, hold_mobile_dedupe: true, hold_join_with_hold: "yes" }) }))
      .toMatchObject({ hold_lean_context: true, hold_mobile_dedupe: true, hold_join_with_hold: false });
    // A test or local override of the `us` base is honoured, and the region names its real host...
    expect(providerRegionOf(getTelnyxConfig({ ...FAKE_TELNYX_ENV, TELNYX_API_BASE_URL: "https://api.telnyx.eu/v2" }))).toBe("eu");
    expect(providerRegionOf(getTelnyxConfig({ ...FAKE_TELNYX_ENV, TELNYX_API_BASE_URL: "https://api.telnyx.com/v2" }))).toBe("us");
    expect(providerRegionOf(getTelnyxConfig({}))).toBe("us");
    // ...while production ignores it: `us` is api.telnyx.com, so an inbound call there freezes `us` with the .com host.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = getTelnyxConfig({ ...FAKE_TELNYX_ENV, MOTORIST_APP_ENV: "production", TELNYX_API_BASE_URL: "https://api.telnyx.eu/v2" });
    expect(production).toMatchObject({ apiBaseUrl: "https://api.telnyx.com/v2" });
    expect(providerRegionOf(production)).toBe("us");
    expect(freezeStartMode(flags, { direction: "inbound", origin: null, providerRegion: providerRegionOf(production) }).apiRegion).toBe("us");
    errors.mockRestore();
  });

  it("freezes the S6 B′ experiment (no link_to on the concurrent far dial) only on TEST and only for a concurrent colleague start", () => {
    const all = { outbound: { web: true, mobile: true }, internal: { web: true, mobile: true } };
    const asked: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: all, internal_auto_bridge: true, concurrent_far_link_to: false };
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ concurrent_far_link_to: false }) }).concurrent_far_link_to).toBe(false);
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    // No link, so no auto-bridge for that start either: Telnyx has nothing to bridge to.
    expect(freezeStartMode(asked, { direction: "internal", origin: "web", providerRegion: "us" })).toMatchObject({ concurrent: true, autoBridge: false, farLinkTo: false });
    expect(freezeStartMode(asked, { direction: "internal", origin: "mobile", providerRegion: "us" })).toMatchObject({ concurrent: true, farLinkTo: false });
    // An outgoing call keeps its linked far dial until an outgoing B′ spike passes.
    for (const origin of ["web", "mobile"] as const) {
      const outbound = freezeStartMode(asked, { direction: "outbound", origin, providerRegion: "us" });
      expect(outbound).toMatchObject({ concurrent: true });
      expect(outbound).not.toHaveProperty("farLinkTo");
    }
    // The default (true) is today's start, field and all.
    const linked = freezeStartMode({ ...asked, concurrent_far_link_to: true }, { direction: "internal", origin: "web", providerRegion: "us" });
    expect(linked).toMatchObject({ concurrent: true, autoBridge: true });
    expect(linked).not.toHaveProperty("farLinkTo");
    // A sequential start links its far dial to the answered own leg, as before.
    const sequential = freezeStartMode({ ...asked, concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: false, mobile: false } } },
      { direction: "internal", origin: "web", providerRegion: "us" });
    expect(sequential).toMatchObject({ concurrent: false, autoBridge: true });
    expect(sequential).not.toHaveProperty("farLinkTo");
    for (const environment of ["production", "development", "staging"]) {
      vi.stubEnv("MOTORIST_APP_ENV", environment);
      expect(freezeStartMode(asked, { direction: "internal", origin: "web", providerRegion: "us" })).not.toHaveProperty("farLinkTo");
    }
  });

  it("passes targetLocalFirst to the console only on TEST until it is proven (S6.4)", () => {
    const asked: LatencyFlags = { ...defaultLatencyFlags(), client: { ...defaultLatencyFlags().client, targetLocalFirst: true } };
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    expect(webCallTuning(asked).targetLocalFirst).toBe(true);
    expect(webCallTuning(defaultLatencyFlags()).targetLocalFirst).toBe(false);
    const environments: Array<Record<string, string>> = [
      { MOTORIST_APP_ENV: "production" }, { MOTORIST_APP_ENV: "", VERCEL_ENV: "production" }, { MOTORIST_APP_ENV: "development" },
      { MOTORIST_APP_ENV: "", VERCEL_ENV: "" }, { MOTORIST_APP_ENV: "staging" },
    ];
    for (const env of environments) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      expect(webCallTuning(asked).targetLocalFirst, JSON.stringify(env)).toBe(false);
      // The other web tuning is not gated.
      expect(webCallTuning({ ...asked, client: { ...asked.client, webPrefetchIce: true } }).webPrefetchIce).toBe(true);
    }
  });

  it("freezes the unproven switches only on TEST: production, a local run, development and an unreadable environment run without them", () => {
    const asked: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: { outbound: { web: true, mobile: true }, internal: { web: true, mobile: true } },
      internal_auto_bridge: true, hold_join_with_hold: true, api_region: "eu" };
    const freeze = () => [
      freezeStartMode(asked, { direction: "outbound", origin: "web", providerRegion: "us", unrecorded: true }),
      freezeStartMode(asked, { direction: "internal", origin: "mobile", providerRegion: "us", unrecorded: true }),
    ];
    // S6 (concurrent, auto-bridge) and S7b (join-with-hold) until their spikes pass; S5 (`eu`) passed S5.0.
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    expect(freeze()).toEqual([
      { concurrent: true, autoBridge: false, ownLegTimeoutSecs: 12, apiRegion: "eu", origin: "web", holdJoinWithHold: true },
      { concurrent: true, autoBridge: true, ownLegTimeoutSecs: 12, apiRegion: "eu", origin: "mobile" },
    ]);
    const sequential = [
      { concurrent: false, autoBridge: false, ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, apiRegion: "us", origin: "web" },
      { concurrent: false, autoBridge: false, ownLegTimeoutSecs: SEQUENTIAL_OWN_LEG_TIMEOUT_SECS, apiRegion: "us", origin: "mobile" },
    ];
    // Production freezes the proven `eu` (S5) with everything else sequential.
    const environments: Array<[string, Record<string, string>, "us" | "eu"]> = [
      ["production", { MOTORIST_APP_ENV: "production" }, "eu"],
      // A Vercel production deployment without the explicit variable is production too.
      ["Vercel production", { MOTORIST_APP_ENV: "", VERCEL_ENV: "production" }, "eu"],
      ["development", { MOTORIST_APP_ENV: "development" }, "us"],
      // `next dev` or a script on a laptop: nothing set resolves to development, which may point at production data.
      ["a local run", { MOTORIST_APP_ENV: "", VERCEL_ENV: "" }, "us"],
      ["an unreadable environment", { MOTORIST_APP_ENV: "staging" }, "us"],
    ];
    for (const [name, env, apiRegion] of environments) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      expect(freeze(), name).toEqual(sequential.map(mode => ({ ...mode, apiRegion })));
    }
  });

  it("freezes the start mode once, at creation; a legacy writer runs the sequential start and records no far end", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const h = createTelephonyHarness();
    const asked: LatencyFlags = { ...defaultLatencyFlags(), concurrent_dial: { outbound: { web: true, mobile: true }, internal: { web: true, mobile: true } },
      internal_auto_bridge: true, api_region: "eu" };
    const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }), latencyFlags: asked };
    const first = await startOutboundCall(deps, { profileId: PROFILES.o1, role: "dispatcher" }, { to: NUMBERS.customer });
    const meta = (sessionId: string) => readMeta(h.session(sessionId) as SessionRow);
    const frozen = { concurrent: true, autoBridge: false, ownLegTimeoutSecs: 12, apiRegion: "eu", origin: "web" };
    expect(meta(first.sessionId).start_mode).toEqual(frozen);
    // A legacy writer has no staged startup entry to carry a far-end dial (S6): a 30 s own-leg dial,
    // the customer only after it answered, and no `far_end`, which is what records the sequential run.
    expect(h.telnyx.of("dial").map(dial => dial.params.timeoutSecs)).toEqual([30]);
    h.telnyx.physical.answered(first.operatorLegCallControlId);
    await h.legEvent(first.operatorLegCallControlId, "call.answered");
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(meta(first.sessionId).far_end).toBeUndefined();
    // Never rewritten after creation: the API region stays pinned (S5).
    expect(meta(first.sessionId).start_mode).toEqual(frozen);

    const second = await callColleague(deps, { profileId: PROFILES.o2, role: "dispatcher" }, { targetProfileId: PROFILES.o5 });
    expect(meta(second.sessionId).start_mode).toEqual({ ...frozen, autoBridge: true });
    // Nor does a legacy writer auto-bridge: the colleague, dialled at the caller's answer, gets the explicit bridge.
    const dials = h.telnyx.of("dial").length;
    h.telnyx.physical.answered(second.operatorLegCallControlId);
    await h.legEvent(second.operatorLegCallControlId, "call.answered");
    expect(h.telnyx.of("dial").slice(dials)).toEqual([expect.objectContaining({ params: expect.not.objectContaining({ bridgeOnAnswer: true }) })]);
    expect(meta(second.sessionId).far_end).toBeUndefined();
    expect(meta(second.sessionId).internal_auto_bridge).toBeUndefined();
    // S5: Telnyx created the inbound call; it keeps the region the deployment calls.
    const inbound = await h.inbound({ to: NUMBERS.allianz, answer: false });
    expect(meta(inbound.sessionId).start_mode).toEqual({ concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "us", origin: null });
  });
});

describe("own-leg request header guard (call-speed S3)", () => {
  const PRIVACY_RPC = "motorist_telephony_start_privacy_v1";
  const env = { TELEPHONY_LATENCY_FLAGS: JSON.stringify({ own_leg_request_header: true }) };
  const asks = (fake: ReturnType<typeof createFakeSupabase>) => fake.db.log.filter(row => row.kind === "rpc" && row.table === PRIVACY_RPC).length;

  it("honours the switch only when the database confirms start privacy", async () => {
    const fake = settings();
    fake.db.registerRpc(PRIVACY_RPC, () => true);
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env })).own_leg_request_header).toBe(true);
    expect(asks(fake)).toBe(1);
  });

  it.each([
    ["denies it", (fake: ReturnType<typeof createFakeSupabase>) => fake.db.registerRpc(PRIVACY_RPC, () => false)],
    ["predates the check (no function)", () => undefined],
    ["fails the check", (fake: ReturnType<typeof createFakeSupabase>) => {
      fake.db.registerRpc(PRIVACY_RPC, () => true);
      fake.db.failNext(PRIVACY_RPC, "rpc", "connection reset");
    }],
  ])("keeps the switch off when the database %s, and logs that once without values", async (_case, arrange) => {
    const logger = vi.fn();
    vi.useFakeTimers();
    for (let round = 0; round < 2; round += 1) {
      const fake = settings({ own_leg_request_header: true });
      arrange(fake);
      expect((await readLatencyFlags(fake.admin, ORG, { logger, env: {} })).own_leg_request_header).toBe(false);
      vi.advanceTimersByTime(LATENCY_FLAGS_CACHE_TTL_MS);
    }
    const warnings = logger.mock.calls.map(([entry]) => entry).filter(entry => entry.level === "warn");
    expect(warnings).toEqual([{ level: "warn", scope: "latency-flags", code: "latency_flag_ignored", problem: "own_leg_request_header:start_privacy_unconfirmed" }]);
  });

  it("keeps the switch off when env asks for it but the flags read fails and privacy is unconfirmed", async () => {
    const fake = settings();
    fake.db.failNext("motorist_telephony_settings", "select", "connection reset");
    expect((await readLatencyFlags(fake.admin, ORG, { logger: () => {}, env })).own_leg_request_header).toBe(false);
  });

  it("asks only while the switch is on, and caches the answer with the flags", async () => {
    const off = settings();
    await readLatencyFlags(off.admin, ORG, { logger: () => {}, env: {} });
    expect(asks(off)).toBe(0);
    clearLatencyFlagsCache();
    const on = settings({ own_leg_request_header: true });
    on.db.registerRpc(PRIVACY_RPC, () => true);
    vi.useFakeTimers();
    await readLatencyFlags(on.admin, ORG, { logger: () => {}, env: {} });
    await readLatencyFlags(on.admin, ORG, { logger: () => {}, env: {} });
    expect(asks(on)).toBe(1);
    vi.advanceTimersByTime(LATENCY_FLAGS_CACHE_TTL_MS);
    await readLatencyFlags(on.admin, ORG, { logger: () => {}, env: {} });
    expect(asks(on)).toBe(2);
  });

  it("never honours it from env alone, where no database confirmed anything", () => {
    vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify({ own_leg_request_header: true, hold_fast_web: true }));
    expect(latencyFlagsOf({ logger: () => {} })).toMatchObject({ own_leg_request_header: false, hold_fast_web: true });
  });
});
