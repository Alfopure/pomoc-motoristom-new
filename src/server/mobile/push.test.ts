import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import type { MotoristActor } from "@/server/api-auth";
import { claimPushes, defaultPushPreferences, mobilePushEnabled, pruneMobilePush, pushOwner, pushRecipients, queueMobilePush, readPushRegistration, registerMobilePush, sendMemberPush, sendMobilePush, unregisterMobilePush } from "./push";

const queued: (() => Promise<unknown>)[] = [];
vi.mock("next/server", () => ({ after: (work: () => Promise<unknown>) => { queued.push(work); } }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test" }));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ME = "00000000-0000-4000-8000-000000000001";
const COLLEAGUE = "00000000-0000-4000-8000-000000000002";
const FORMER = "00000000-0000-4000-8000-000000000003";
const PHONE = "00000000-0000-4000-8000-0000000000f1";
const actor: MotoristActor = { userId: "u1", profileId: ME, organizationId: ORG, displayName: "Ja", role: "dispatcher" };
const token = (suffix: string) => "ExponentPushToken[" + suffix.padEnd(12, "x") + "]";
const NOW = new Date("2026-10-21T10:00:00.000Z");

let fake: FakeSupabase;
const devices = () => fake.db.storage("motorist_mobile_push_devices");
const expoOk = (count: number, errors: Record<number, string> = {}) => vi.fn(async (_url: string, init: RequestInit) => {
  const sent = JSON.parse(String(init.body)) as unknown[];
  expect(sent).toHaveLength(count);
  return new Response(JSON.stringify({ data: sent.map((_, index) => errors[index]
    ? { status: "error", message: "gone", details: { error: errors[index] } } : { status: "ok", id: "ticket-" + index }) }), { status: 200 });
});

beforeEach(() => {
  fake = createFakeSupabase({ now: () => NOW, uniqueKeys: { motorist_mobile_push_devices: [["id"], ["environment", "installation_id"], ["expo_push_token"]] } });
  fake.db.seed("motorist_profiles", [
    { id: ME, organization_id: ORG, active: true, access_status: "active", role: "dispatcher", kind: "human" },
    { id: COLLEAGUE, organization_id: ORG, active: true, access_status: "active", role: "senior_dispatcher", kind: "human" },
    { id: FORMER, organization_id: ORG, active: false, access_status: "disabled", role: "dispatcher", kind: "human" },
  ]);
  vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
  queued.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

function device(profileId: string, installation: string, pushToken: string, preferences: Record<string, boolean> = {}, lastSeen = NOW.toISOString()) {
  return { organization_id: ORG, profile_id: profileId, environment: "test", installation_id: installation, expo_push_token: pushToken,
    platform: "ios", preferences, app_version: "1.0.0", created_at: lastSeen, updated_at: lastSeen, last_seen_at: lastSeen };
}

describe("push registration", () => {
  it("is off unless the project switches it on, and never on a working-branch Preview", () => {
    expect(mobilePushEnabled({})).toBe(false);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: "1" })).toBe(false);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: "true" })).toBe(true);
    const stableTest = { MOBILE_PUSH_ENABLED: "true", MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
      APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" };
    expect(mobilePushEnabled(stableTest)).toBe(true);
    expect(mobilePushEnabled({ ...stableTest, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" })).toBe(false);
    expect(mobilePushEnabled({ ...stableTest, VERCEL_PROJECT_ID: "prj_other" })).toBe(false);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: "true", MOTORIST_APP_ENV: "production", VERCEL_ENV: "production", SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" })).toBe(true);
  });

  it("accepts only an installation, an Expo token and known switches", () => {
    const valid = { installationId: PHONE.toUpperCase(), token: token("abc"), platform: "ios", appVersion: "1.0.0", preferences: { cases: false } };
    expect(readPushRegistration(valid)).toEqual({ installationId: PHONE, token: token("abc"), platform: "ios", appVersion: "1.0.0", preferences: { cases: false } });
    for (const value of [null, [], { ...valid, extra: 1 }, { ...valid, installationId: "phone" }, { ...valid, token: "abc" }, { ...valid, token: "ExpoPushToken[a b]" },
      { ...valid, platform: "web" }, { ...valid, appVersion: "x".repeat(41) }, { ...valid, preferences: { cases: "no" } }, { ...valid, preferences: [] }]) {
      expect(() => readPushRegistration(value)).toThrow();
    }
    // A switch of a newer app does not break an older server.
    expect(readPushRegistration({ ...valid, preferences: { cases: false, sms: true } }).preferences).toEqual({ cases: false });
  });

  it("refuses to register where push is not switched on or the table is missing", async () => {
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    await expect(registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" })).rejects.toMatchObject({ status: 503, code: "push_unavailable" });
    vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
    fake.db.failNext("motorist_mobile_push_devices", "select", { message: "missing", code: "PGRST205", details: null, hint: null });
    await expect(registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" })).rejects.toMatchObject({ status: 503, code: "push_unavailable" });
  });

  it("stores this phone for the signed-in operator with the default switches", async () => {
    const result = await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios", appVersion: "1.0.0", preferences: { callbacks_unclaimed: false } }, NOW);
    expect(result.preferences).toEqual({ ...defaultPushPreferences(), callbacks_unclaimed: false });
    expect(devices()).toEqual([expect.objectContaining({ organization_id: ORG, profile_id: ME, environment: "test", installation_id: PHONE, expo_push_token: token("abc"), platform: "ios" })]);
    // Changing one switch later keeps the others.
    const again = await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios", preferences: { cases: false } }, NOW);
    expect(again.preferences).toEqual({ ...defaultPushPreferences(), callbacks_unclaimed: false, cases: false });
    expect(devices()).toHaveLength(1);
  });

  it("starts from the defaults when another account signs in on the same phone", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(COLLEAGUE, PHONE, token("abc"), { tasks: false, cases: false })]);
    const result = await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" }, NOW);
    expect(result.preferences).toEqual(defaultPushPreferences());
    expect(devices()).toEqual([expect.objectContaining({ profile_id: ME, installation_id: PHONE })]);
  });

  it("registers a pristavovač's phone by member, and a later dispatcher takes the phone over cleanly", async () => {
    const MEMBER = "00000000-0000-4000-8000-0000000000e1";
    const member = { organizationId: ORG, profileId: null, memberId: MEMBER };
    await expect(registerMobilePush(fake.admin, member, { installationId: PHONE, token: token("abc"), platform: "ios", preferences: { handoffs: false } }, NOW)).resolves.toMatchObject({ preferences: { handoffs: false } });
    expect(devices()).toEqual([expect.objectContaining({ member_id: MEMBER, profile_id: null, installation_id: PHONE })]);
    await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" }, NOW);
    expect(devices()).toEqual([expect.objectContaining({ profile_id: ME, installation_id: PHONE })]);
    expect(devices()[0].member_id ?? null).toBeNull();
  });

  it("registers one phone for someone who dispatches and delivers, keeping their switches", async () => {
    const MEMBER = "00000000-0000-4000-8000-0000000000e1";
    await registerMobilePush(fake.admin, { organizationId: ORG, profileId: ME, memberId: MEMBER }, { installationId: PHONE, token: token("abc"), platform: "ios", preferences: { cases: false } }, NOW);
    expect(devices()).toEqual([expect.objectContaining({ profile_id: ME, member_id: MEMBER, installation_id: PHONE })]);
    // Without the delivery role later: still their phone and their switches.
    const later = await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" }, NOW);
    expect(later.preferences.cases).toBe(false);
    await expect(registerMobilePush(fake.admin, { organizationId: ORG, profileId: null, memberId: null }, { installationId: PHONE, token: token("abc"), platform: "ios" }, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it("keeps a token on one installation only", async () => {
    const other = "00000000-0000-4000-8000-0000000000f2";
    fake.db.seed("motorist_mobile_push_devices", [device(ME, other, token("abc"))]);
    await registerMobilePush(fake.admin, pushOwner(actor), { installationId: PHONE, token: token("abc"), platform: "ios" }, NOW);
    expect(devices().map(row => row.installation_id)).toEqual([PHONE]);
  });

  it("forgets this phone at logout, also when an earlier account left it registered", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(COLLEAGUE, PHONE, token("earlier")), device(COLLEAGUE, "00000000-0000-4000-8000-0000000000f2", token("theirs"))]);
    await expect(unregisterMobilePush(fake.admin, { installationId: PHONE })).resolves.toEqual({ removed: true });
    await expect(unregisterMobilePush(fake.admin, { installationId: PHONE })).resolves.toEqual({ removed: false });
    expect(devices().map(row => row.installation_id)).toEqual(["00000000-0000-4000-8000-0000000000f2"]);
    await expect(unregisterMobilePush(fake.admin, { installationId: PHONE, token: "x" })).rejects.toMatchObject({ status: 400 });
    fake.db.failNext("motorist_mobile_push_devices", "delete", { message: "missing", code: "42P01", details: null, hint: null });
    await expect(unregisterMobilePush(fake.admin, { installationId: PHONE })).resolves.toEqual({ removed: false });
  });
});

describe("push delivery", () => {
  const message = { organizationId: ORG, type: "tasks" as const, title: "Nová úloha", body: "Máte pridelenú úlohu.", data: { kind: "task" as const, id: "t1" }, dedupeKey: "task-assigned:n1" };

  it("reaches only active people whose switch is on, once per event", async () => {
    fake.db.seed("motorist_mobile_push_devices", [
      device(ME, PHONE, token("mine")),
      device(COLLEAGUE, "00000000-0000-4000-8000-0000000000f2", token("muted"), { tasks: false }),
      device(FORMER, "00000000-0000-4000-8000-0000000000f3", token("former")),
    ]);
    const transport = expoOk(1);
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME, COLLEAGUE, FORMER] }, transport)).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(JSON.parse(String(init.body))).toEqual([{ to: token("mine"), title: "Nová úloha", body: "Máte pridelenú úlohu.", data: { kind: "task", id: "t1", profileId: ME }, sound: "default", priority: "high" }]);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    // The claim is an archived row the web never lists.
    expect(fake.db.storage("motorist_notifications")).toEqual([expect.objectContaining({ recipient_profile_id: ME, status: "archived", kind: "system", dedupe_key: "mobile-push:task-assigned:n1:" + ME })]);

    const again = vi.fn();
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, again)).resolves.toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(again).not.toHaveBeenCalled();
  });

  it("sends nothing when switched off and never throws", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("mine"))]);
    const transport = vi.fn();
    vi.stubEnv("MOBILE_PUSH_ENABLED", "false");
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, transport)).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 });
    vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = vi.fn(async () => { throw new Error("network down"); });
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, broken, 0)).resolves.toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(broken).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toContain(token("mine"));
    warn.mockRestore();
    expect(transport).not.toHaveBeenCalled();
    // Nobody was reached, so the same event may be sent again later.
    expect(fake.db.storage("motorist_notifications")).toEqual([]);
    const later = expoOk(1);
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, later, 0)).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it("retries a passing failure of the push service once", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("mine"))]);
    const ok = expoOk(1);
    const flaky = vi.fn(async (url: string, init: RequestInit) => flaky.mock.calls.length === 1 ? new Response("busy", { status: 503 }) : ok(url, init));
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, flaky, 0)).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(fake.db.storage("motorist_notifications")).toHaveLength(1);
  });

  it("forgets a phone whose app was removed and uses the access token when configured", async () => {
    vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("gone")), device(ME, "00000000-0000-4000-8000-0000000000f2", token("kept"))]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = expoOk(2, { 0: "DeviceNotRegistered" });
    await expect(sendMobilePush(fake.admin, { ...message, profileIds: [ME] }, transport, 0)).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(new Headers(transport.mock.calls[0][1].headers).get("authorization")).toBe("Bearer expo-secret");
    expect(devices().map(row => row.expo_push_token)).toEqual([token("kept")]);
    warn.mockRestore();
  });

  it("leaves a phone unused for a month alone and handles a missing table", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("old"), {}, "2026-09-01T10:00:00.000Z")]);
    await expect(pushRecipients(fake.admin, ORG, "tasks", [ME], NOW)).resolves.toEqual(new Map());
    fake.db.failNext("motorist_mobile_push_devices", "select", { message: "missing", code: "42P01", details: null, hint: null });
    await expect(pushRecipients(fake.admin, ORG, "tasks", "team", NOW)).resolves.toEqual(new Map());
  });

  it("forgets phones silent for 90 days and announcements older than 30 days", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("recent"), {}, "2026-08-01T10:00:00.000Z"), device(COLLEAGUE, "00000000-0000-4000-8000-0000000000f2", token("silent"), {}, "2026-07-01T10:00:00.000Z")]);
    fake.db.seed("motorist_notifications", [
      { organization_id: ORG, recipient_profile_id: ME, kind: "system", status: "archived", dedupe_key: "mobile-push:old", created_at: "2026-09-01T10:00:00.000Z" },
      { organization_id: ORG, recipient_profile_id: ME, kind: "system", status: "archived", dedupe_key: "mobile-push:new", created_at: "2026-10-20T10:00:00.000Z" },
      { organization_id: ORG, recipient_profile_id: ME, kind: "system", status: "archived", dedupe_key: "call-push:old", created_at: "2026-09-01T10:00:00.000Z" },
    ]);
    await expect(pruneMobilePush(fake.admin, ORG, NOW)).resolves.toEqual({ devices: 1, claims: 1 });
    expect(devices().map(row => row.expo_push_token)).toEqual([token("recent")]);
    expect(fake.db.storage("motorist_notifications").map(row => row.dedupe_key)).toEqual(["mobile-push:new", "call-push:old"]);
  });

  it("sends a delivery notice only to an active pristavovač's phone, never to dispatchers", async () => {
    const MEMBER = "00000000-0000-4000-8000-0000000000e1", GONE = "00000000-0000-4000-8000-0000000000e2";
    fake.db.seed("motorist_towing_memberships", [{ id: MEMBER, organization_id: ORG, active: true, capabilities: ["deliver"] }, { id: GONE, organization_id: ORG, active: false, capabilities: ["deliver"] }]);
    fake.db.seed("motorist_mobile_push_devices", [
      { ...device(ME, PHONE, token("dispatcher")) },
      { ...device(ME, "00000000-0000-4000-8000-0000000000f2", token("pavol")), profile_id: null, member_id: MEMBER },
      { ...device(ME, "00000000-0000-4000-8000-0000000000f3", token("former")), profile_id: null, member_id: GONE },
    ]);
    const transport = expoOk(1);
    await expect(sendMemberPush(fake.admin, { organizationId: ORG, memberIds: [MEMBER, GONE], title: "Nové pristavenie", body: "Prípad PM-1.", data: { kind: "delivery", id: "d1" } }, transport, 0))
      .resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(JSON.parse(String(transport.mock.calls[0][1].body))[0]).toMatchObject({ to: token("pavol"), data: { kind: "delivery", id: "d1", profileId: MEMBER } });
    // Team notices for dispatchers skip a pristavovač's phone.
    const team = await pushRecipients(fake.admin, ORG, "callbacks_unclaimed", "team", NOW);
    expect([...team.keys()]).toEqual([ME]);
  });

  it("finds the whole team for a team notice", async () => {
    fake.db.seed("motorist_mobile_push_devices", [device(ME, PHONE, token("mine")), device(COLLEAGUE, "00000000-0000-4000-8000-0000000000f2", token("theirs"))]);
    const team = await pushRecipients(fake.admin, ORG, "callbacks_unclaimed", "team", NOW);
    expect([...team.keys()].sort()).toEqual([ME, COLLEAGUE]);
    expect(await claimPushes(fake.admin, ORG, [])).toEqual(new Set());
  });

  it("queues work after the response only when switched on", async () => {
    const work = vi.fn(async () => { throw new Error("ignored"); });
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    queueMobilePush(work);
    expect(queued).toHaveLength(0);
    vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
    queueMobilePush(work);
    expect(queued).toHaveLength(1);
    await expect(queued[0]()).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledOnce();
  });
});
