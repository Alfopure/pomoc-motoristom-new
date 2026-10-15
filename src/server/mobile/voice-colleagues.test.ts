import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { getMobileVoiceColleagues, readColleagueQuery, requireMobileColleague } from "./voice-colleagues";
const actor = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: "Caller", role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const h = createTelephonyHarness();
  h.db.update("motorist_profiles", { kind: "human" }, () => true);
  vi.stubEnv("MOTORIST_APP_ENV", "test");
  return { h, read: (q = "") => getMobileVoiceColleagues(actor, q, h.admin, h.now()) };
}
describe("mobile colleague read model", () => {
  it("is bounded, scoped, excludes self, and exposes no endpoint credentials", async () => {
    const { h, read } = fixture();
    const result = await read();
    expect(result.hasMore).toBe(false); expect(result.colleagues.length).toBeGreaterThan(0);
    expect(result.colleagues.some(p => p.profileId === actor.profileId)).toBe(false);
    expect(result.colleagues.find(p => p.profileId === PROFILES.o2)).toMatchObject({ canCall: true, status: "available", reason: null });
    expect(JSON.stringify(result)).not.toMatch(/sip:|gencred|telnyx|@/);
    expect(h.telnyx.calls).toHaveLength(0);
  });
  it.each([
    [{ status: "paused" }, "paused", null], [{ status: "on_call" }, "busy", "busy"],
    [{ status: "after_call_work", wrap_up_until: "2099-01-01T00:00:00Z" }, "busy", "wrap_up"],
    [{ status: "offline" }, "offline", "offline"], [{ status: "available", current_session_id: "busy" }, "busy", "busy"],
  ] as const)("uses existing colleague presence semantics %j", async (patch, status, reason) => {
    const { h, read } = fixture(); h.db.update("motorist_operator_presence", patch, row => row.profile_id === PROFILES.o2);
    expect((await read()).colleagues.find(p => p.profileId === PROFILES.o2)).toMatchObject({ status, reason, canCall: reason === null });
  });
  it.each([{ active: false }, { access_status: "invited" }, { kind: "ai" }, { role: "driver" }, { organization_id: PROFILES.o1 }])("excludes ineligible targets %j", async patch => {
    const { h, read } = fixture(); h.db.update("motorist_profiles", patch, row => row.id === PROFILES.o2);
    expect((await read()).colleagues.some(p => p.profileId === PROFILES.o2)).toBe(false);
    await expect(requireMobileColleague(h.admin, actor, PROFILES.o2)).rejects.toMatchObject({ status: 404 });
  });
  it("does not use another environment's live endpoint", async () => {
    const { h, read } = fixture(); h.db.update("motorist_operator_devices", { environment: "production" }, row => row.profile_id === PROFILES.o2);
    expect((await read()).colleagues.find(p => p.profileId === PROFILES.o2)).toMatchObject({ canCall: false, reason: "no_phone" });
  });
  it("searches names without adopting a caller identity", async () => {
    const { h, read } = fixture(); h.db.update("motorist_profiles", { display_name: "100% Test" }, row => row.id === PROFILES.o2);
    expect((await read("Test")).colleagues.map(p => p.profileId)).toEqual([PROFILES.o2]);
  });
  it("uses a sentinel row instead of an unbounded directory", async () => {
    const { h, read } = fixture();
    for (let i = 0; i < 55; i++) h.db.seed("motorist_profiles", [{ id: `00000000-0000-4000-8000-${String(500+i).padStart(12,"0")}`, organization_id: ORG, display_name: "Extra " + i, active: true, access_status: "active", role: "dispatcher", kind: "human" }]);
    const result = await read(); expect(result.colleagues).toHaveLength(50); expect(result.hasMore).toBe(true);
  });
  it.each(["motorist_profiles", "motorist_operator_presence", "motorist_operator_devices"])("does not report empty success on %s failure", async table => {
    const { h, read } = fixture(); h.db.failNext(table, "select", "private failure");
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
  it("trims and bounds only the allowlisted query", () => {
    expect(readColleagueQuery(new URLSearchParams("q=%20Jan%20"))).toBe("Jan");
    for (const q of ["q=a&q=b", "q=*", "targetProfileId=spoof", "q="+"a".repeat(81)]) expect(() => readColleagueQuery(new URLSearchParams(q))).toThrow();
  });
});

describe("colleague endpoint hints", () => {
  function nativeFixture() {
    const f = fixture();
    for (const [key, value] of Object.entries({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
      SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
    const web = f.h.rows("motorist_operator_devices").find(row => row.profile_id === PROFILES.o2)!;
    const lease = "00000000-0000-4000-8000-000000000071";
    f.h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-only", device_session_id: lease,
      credential_expires_at: "2026-09-04T08:00:00Z", metadata: { native_voip: { v: 1, platform: "ios", deviceSessionId: lease, until: "2026-09-04T08:00:00Z" } } }]);
    f.h.db.update("motorist_operator_devices", { registration_state: "unregistered" }, row => row.profile_id === PROFILES.o2);
    return f;
  }
  it("permits fresh mobile and bounded push-only reachability, gated by TEST flags", async () => {
    const { h, read } = nativeFixture();
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)?.canCall).toBe(true);
    h.advance(180_000);
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)?.canCall).toBe(true);
    vi.stubEnv("MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED", "false");
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)?.reason).toBe("no_phone");
  });
  it("never reads native endpoints when the exact native deployment gate is closed", async () => {
    const { h, read } = nativeFixture(); vi.stubEnv("VERCEL_ENV", "preview");
    h.db.failNext("motorist_operator_mobile_devices", "select", "must not read");
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)?.reason).toBe("no_phone");
    expect(h.db.log.some(row => row.table === "motorist_operator_mobile_devices")).toBe(false);
  });
  it("does not invent availability after an enabled native query fails", async () => {
    const { h, read } = nativeFixture(); h.db.failNext("motorist_operator_mobile_devices", "select", "private error");
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
  it("respects personal-mobile delivery and strict settings failures", async () => {
    const { h, read } = fixture(); vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    h.db.seed("motorist_operator_telephony_settings", [{ organization_id: ORG, profile_id: PROFILES.o2, delivery_mode: "personal_mobile" }]);
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)).toMatchObject({ canCall: false, reason: "personal_mobile" });
    h.db.failNext("motorist_operator_telephony_settings", "select", "private error");
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
});


describe("installed Supabase directory transport", () => {
  it("escapes name wildcards and scopes every bounded related read", async () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const requests: URL[] = [];
    const admin = createClient<Database>("https://fixture.supabase.co", "fixture", { auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async input => {
        const url = new URL(String(input)); requests.push(url);
        return new Response(JSON.stringify(url.pathname.endsWith("motorist_profiles") ? [{ id: PROFILES.o2, display_name: "100%_\\ Name" }] : []), { status: 200, headers: { "Content-Type": "application/json" } });
      } },
    });
    await getMobileVoiceColleagues(actor, "100%_\\", admin);
    expect(requests).toHaveLength(4);
    const profile = requests[0].searchParams;
    expect(profile.get("display_name")).toBe("ilike.%100\\%\\_\\\\%");
    expect(profile.get("select")).toBe("id,display_name"); expect(profile.get("limit")).toBe("51");
    expect(profile.get("order")).toBe("display_name.asc,id.asc"); expect(profile.get("kind")).toBe("eq.human");
    expect(profile.get("active")).toBe("eq.true"); expect(profile.get("access_status")).toBe("eq.active");
    expect(profile.get("id")).toBe("neq." + actor.profileId);
    for (const url of requests) expect(url.searchParams.get("organization_id")).toBe("eq." + actor.organizationId);
    for (const url of requests.slice(1)) expect(url.searchParams.get("profile_id")).toBe("in.(" + PROFILES.o2 + ")");
    expect(requests.find(url => url.pathname.endsWith("motorist_operator_devices"))?.searchParams.get("environment")).toBe("eq.development");
  });
});


describe("safe colleague presentation names", () => {
  it.each([
    ["  Ja\nna\u007f  ", "Jana"], [" \r\n ", "Kolega"], [null, "Kolega"],
    ["x".repeat(119) + "😀", "x".repeat(119)], ["x".repeat(150), "x".repeat(120)],
  ])("sanitizes profile display name %j without an endpoint fallback", async (raw, expected) => {
    const { h, read } = fixture(); h.db.update("motorist_profiles", { display_name: raw }, row => row.id === PROFILES.o2);
    expect((await read()).colleagues.find(row => row.profileId === PROFILES.o2)?.displayName).toBe(expected);
  });
});
