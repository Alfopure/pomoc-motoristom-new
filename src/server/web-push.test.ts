import { createECDH, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import {
  deletePushSubscription, getPushConfig, getPushSubscriptionStatus, parsePushSubscription,
  savePushSubscription, sendTaskPush, sendTestPush, sendCallPush, updatePushSound, updatePushPreferences, validatePushEndpoint,
} from "./web-push";

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ default: { sendNotification } }));

type DbResult = { data?: unknown; error?: { code?: string; message: string } | null; wait?: Promise<void>; beforeResolve?: () => void };
function database(results: DbResult[], configResult: DbResult = { data: null }) {
  const queries: { table: string; operations: { name: string; args: unknown[] }[] }[] = [];
  const rpc = vi.fn().mockImplementation(() => {
    const request = Object.assign(Promise.resolve({ error: null, ...configResult }), { abortSignal: vi.fn() });
    request.abortSignal.mockReturnValue(request);
    return request;
  });
  const db = {
    rpc,
    from(table: string) {
      const result = results.shift();
      if (!result) throw new Error(`Unexpected query: ${table}`);
      const operations: { name: string; args: unknown[] }[] = [];
      queries.push({ table, operations });
      const chain = new Proxy({}, { get(_target, name: string) {
        if (name === "then") return async (resolve: (value: unknown) => unknown) => {
          await result.wait;
          result.beforeResolve?.();
          return resolve({ data: null, error: null, ...result });
        };
        return (...args: unknown[]) => { operations.push({ name, args }); return chain; };
      } });
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
  return { db, queries, rpc };
}

const actor = { organizationId: "org-a", profileId: "profile-a" };
const key = createECDH("prime256v1");
// Stable 32-byte scalar: random ECDH.getPrivateKey() can drop a leading zero,
// yielding a 31-byte value that is not a valid encoded VAPID private key.
key.setPrivateKey(Buffer.alloc(32, 1));
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-token",
  keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  expirationTime: null,
};
const row = {
  id: "sub-a", organization_id: actor.organizationId, profile_id: actor.profileId,
  endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
  sound_enabled: false, expires_at: null, last_test_at: null,
};
const message = { organizationId: actor.organizationId, recipientProfileId: actor.profileId, notificationId: "notification-a", taskId: "task-a", title: "Nová úloha", body: "Zavolajte klientovi" };
const callRow = { ...row, task_notifications_enabled: true, incoming_calls_enabled: true, available_calls_enabled: true };
const callMessage = () => ({ organizationId: actor.organizationId, recipientProfileId: actor.profileId, sessionId: "09b1967e-c23c-4db1-88de-1b08ce233ae8", category: "incoming_call" as const, title: "Prichádzajúci hovor", body: "Otvorte aplikáciu.", expiresAt: new Date(Date.now() + 25_000).toISOString() });

beforeEach(() => {
  vi.stubEnv("VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("VAPID_SUBJECT", "https://test.dispecing.linkapomoci.sk");
  sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("device notification categories", () => {
  it("updates only the requested category and scopes it to the authenticated owner", async () => {
    const { db, queries } = database([{ data: { id: row.id } }]);
    await updatePushPreferences(db, actor, row.endpoint, { incomingCallsEnabled: false, profileId: "someone-else" });
    expect(queries[0].operations).toEqual(expect.arrayContaining([
      { name: "update", args: [{ incoming_calls_enabled: false }] },
      { name: "eq", args: ["organization_id", actor.organizationId] },
      { name: "eq", args: ["profile_id", actor.profileId] },
      { name: "eq", args: ["endpoint", row.endpoint] },
    ]));
  });

  it.each([{}, [], null, { incomingCallsEnabled: "false" }, { availableCallsEnabled: null }, { taskNotificationsEnabled: 0 }])("rejects invalid or empty settings %j", async (input) => {
    const { db } = database([]);
    await expect(updatePushPreferences(db, actor, row.endpoint, input)).rejects.toMatchObject({ status: 400 });
  });

  it("returns the actual device choices and reports legacy schemas without breaking task pushes", async () => {
    const { db } = database([{ data: { ...callRow, incoming_calls_enabled: false, task_notifications_enabled: false } }]);
    expect(await getPushSubscriptionStatus(db, actor, row.endpoint)).toMatchObject({ subscribed: true, callNotificationsConfigured: true, incomingCallsEnabled: false, availableCallsEnabled: true, taskNotificationsEnabled: false });
    const legacy = database([{ error: { code: "42703", message: "column task_notifications_enabled does not exist" } }]);
    expect(await getPushSubscriptionStatus(legacy.db, actor)).toMatchObject({ configured: true, callNotificationsConfigured: false });
  });

  it.each([null, { ...callRow, expires_at: "2020-01-01T00:00:00.000Z" }])("reports category capability even when an endpoint is missing or expired", async (subscriptionRow) => {
    const { db, queries } = database([{ data: subscriptionRow }, { data: [] }]);
    expect(await getPushSubscriptionStatus(db, actor, row.endpoint)).toMatchObject({ subscribed: false, callNotificationsConfigured: true });
    expect(queries[1].operations).toEqual(expect.arrayContaining([
      { name: "eq", args: ["organization_id", actor.organizationId] }, { name: "eq", args: ["profile_id", actor.profileId] },
    ]));
    const legacy = database([{ data: subscriptionRow }, { error: { code: "42703", message: "column incoming_calls_enabled does not exist" } }]);
    expect(await getPushSubscriptionStatus(legacy.db, actor, row.endpoint)).toMatchObject({ subscribed: false, callNotificationsConfigured: false });
  });

  it("task opt-out filters only that device, leaving other device subscriptions enabled", async () => {
    const { db } = database([{ data: { id: actor.profileId } }, { data: [{ ...callRow, task_notifications_enabled: false }, { ...callRow, id: "sub-b", endpoint: "https://fcm.googleapis.com/fcm/send/second" }] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 1, failed: 0 });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0][0].endpoint).toContain("second");
  });
});

describe("short-lived call push delivery", () => {
  it("claims once before sending with a call link, short TTL, category and device sound", async () => {
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim-a" } }, { data: callRow }]);
    const input = callMessage();
    expect(await sendCallPush(db, input)).toEqual({ sent: 1, failed: 0 });
    const payload = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(payload).toMatchObject({ url: `/?call=${input.sessionId}`, tag: `call-${input.sessionId}`, callSessionId: input.sessionId, callKind: "incoming_call", expiresAt: input.expiresAt, soundEnabled: false });
    expect(sendNotification.mock.calls[0][2]).toMatchObject({ urgency: "high", timeout: 2000 });
    expect(sendNotification.mock.calls[0][2].TTL).toBeLessThanOrEqual(25);
    expect(sendNotification.mock.calls[0][2].TTL).toBeGreaterThan(0);
    const claim = queries[2].operations.find((op) => op.name === "upsert")!;
    expect(claim.args[0]).toMatchObject({ organization_id: actor.organizationId, recipient_profile_id: actor.profileId, visibility: "private", status: "archived", dedupe_key: `call-push:${input.sessionId}:${actor.profileId}:incoming_call` });
    expect(claim.args[1]).toEqual({ onConflict: "organization_id,dedupe_key", ignoreDuplicates: true });
  });

  it("repeated webhook/claim conflicts never send another push", async () => {
    for (const result of [{ data: null }, { error: { code: "23505", message: "already claimed" } }]) {
      const { db } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, result]);
      expect(await sendCallPush(db, callMessage())).toEqual({ sent: 0, failed: 0 });
    }
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("incoming and available-call opt-outs are independent", async () => {
    const disabledIncoming = { ...callRow, incoming_calls_enabled: false };
    const { db } = database([{ data: { id: actor.profileId } }, { data: [disabledIncoming] }]);
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 0, failed: 0 });
    const allowed = database([{ data: { id: actor.profileId } }, { data: [disabledIncoming] }, { data: { id: "claim" } }, { data: disabledIncoming }]);
    expect(await sendCallPush(allowed.db, { ...callMessage(), category: "available_call" })).toEqual({ sent: 1, failed: 0 });
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("missing category columns, no subscriptions and inactive users fail closed", async () => {
    for (const devices of [[], [row], [{ ...callRow, available_calls_enabled: false }]]) {
      const { db } = database([{ data: { id: actor.profileId } }, { data: devices }]);
      expect(await sendCallPush(db, { ...callMessage(), category: "available_call" })).toEqual({ sent: 0, failed: 0 });
    }
    expect(await sendCallPush(database([{}]).db, callMessage())).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not send expired calls or retry a transient failure after the ringing window", async () => {
    expect(await sendCallPush(database([]).db, { ...callMessage(), expiresAt: new Date(Date.now() - 1).toISOString() })).toEqual({ sent: 0, failed: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendNotification.mockRejectedValue({ statusCode: 503, body: "private-provider-error" });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: callRow }]);
    expect(await sendCallPush(db, { ...callMessage(), expiresAt: new Date(Date.now() + 400).toISOString() })).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-provider-error");
  });

  it("cleans an expired push endpoint with owner scoping", async () => {
    sendNotification.mockRejectedValue({ statusCode: 410 });
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: callRow }, {}]);
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(queries[4].operations).toEqual(expect.arrayContaining([
      { name: "eq", args: ["organization_id", actor.organizationId] },
      { name: "eq", args: ["profile_id", actor.profileId] },
      { name: "eq", args: ["id", row.id] },
    ]));
  });

  it("delivers to more than ten devices with bounded concurrency instead of silently discarding the rest", async () => {
    const devices = Array.from({ length: 23 }, (_, index) => ({ ...callRow, id: `device-${index}`, endpoint: `${row.endpoint}-${index}` }));
    const { db } = database([{ data: { id: actor.profileId } }, { data: devices }, { data: { id: "claim" } }, ...devices.map((device) => ({ data: device }))]);
    let active = 0;
    let maxActive = 0;
    sendNotification.mockImplementation(async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      await Promise.resolve();
      active--;
      return { statusCode: 201 };
    });
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 23, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(23);
    expect(maxActive).toBeLessThanOrEqual(10);
    expect(new Set(sendNotification.mock.calls.map(([subscription]) => subscription.endpoint)).size).toBe(23);
  });

  it.each([null, { ...callRow, incoming_calls_enabled: false }])("honors deletion or opt-out completed while the durable claim was pending", async (current) => {
    let release!: () => void;
    const claimWait = new Promise<void>((resolve) => { release = resolve; });
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" }, wait: claimWait }, { data: current }]);
    const pending = sendCallPush(db, callMessage());
    await vi.waitFor(() => expect(queries).toHaveLength(3));
    expect(sendNotification).not.toHaveBeenCalled();
    release();
    expect(await pending).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(queries[3].operations).toEqual(expect.arrayContaining([
      { name: "eq", args: ["organization_id", actor.organizationId] }, { name: "eq", args: ["profile_id", actor.profileId] },
      { name: "eq", args: ["id", row.id] }, { name: "eq", args: ["endpoint", row.endpoint] },
      { name: "eq", args: ["incoming_calls_enabled", true] },
    ]));
  });

  it("uses the device sound setting current at delivery, not the pre-claim snapshot", async () => {
    const { db } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: { ...callRow, sound_enabled: true } }]);
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse(sendNotification.mock.calls[0][1]).soundEnabled).toBe(true);
  });

  it.each([{ statusCode: 503 }, { code: "ECONNRESET" }, { statusCode: 429, headers: { "retry-after": "0.1" } }])("retries once inside the call deadline and keeps the collapse topic: %j", async (failure) => {
    sendNotification.mockRejectedValueOnce(failure).mockResolvedValueOnce({ statusCode: 201 });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: callRow }, { data: callRow }]);
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 1, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0][2].topic).toBe(sendNotification.mock.calls[1][2].topic);
    expect(sendNotification.mock.calls[1][2].TTL).toBeLessThanOrEqual(sendNotification.mock.calls[0][2].TTL);
  });

  it("rechecks the device category after provider backoff and suppresses a disabled retry", async () => {
    sendNotification.mockRejectedValueOnce({ statusCode: 503 });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: callRow }, { data: { ...callRow, incoming_calls_enabled: false } }]);
    expect(await sendCallPush(db, callMessage())).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("checks expiry again after a delayed retry timer before issuing a second provider request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-25T10:00:00.000Z");
    const input = { ...callMessage(), expiresAt: new Date(Date.now() + 1_000).toISOString() };
    sendNotification.mockRejectedValueOnce({ statusCode: 503 });
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [callRow] }, { data: { id: "claim" } }, { data: callRow }]);
    const pending = sendCallPush(db, input);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendNotification).toHaveBeenCalledOnce();
    vi.setSystemTime("2026-09-25T10:00:02.000Z");
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(queries).toHaveLength(4);
  });

  it("counts every remaining device if the bounded delivery budget is consumed", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const devices = Array.from({ length: 23 }, (_, index) => ({ ...callRow, id: `device-${index}`, endpoint: `${row.endpoint}-${index}` }));
    const { db } = database([
      { data: { id: actor.profileId } }, { data: devices },
      { data: { id: "claim" }, beforeResolve: () => vi.mocked(Date.now).mockReturnValue(now + 5_001) },
    ]);
    expect(await sendCallPush(db, { ...callMessage(), expiresAt: new Date(now + 25_000).toISOString() })).toEqual({ sent: 0, failed: 23 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("push subscription validation", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/token",
    "https://wns2-bl2p.notify.windows.com/w/?token=opaque",
  ])("accepts real browser vendor endpoints: %s", (endpoint) => expect(validatePushEndpoint(endpoint)).toBe(endpoint));

  it.each([
    "http://fcm.googleapis.com/fcm/send/token", "https://127.0.0.1/push", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/push", "https://fcm.googleapis.com.evil.test/push", "https://evilpush.apple.com/push",
    "https://fcm.googleapis.com:444/push", "https://user:password@fcm.googleapis.com/push",
    "https://fcm.googleapis.com/push#fragment", "https://notify.windows.com.evil.test/push", "file:///etc/passwd", "https://fcm.googleapis.com/",
  ])("refuses SSRF, credentials and ambiguous endpoints: %s", (endpoint) => expect(() => validatePushEndpoint(endpoint)).toThrow());

  it("validates curve keys and expiration, without echoing secrets", () => {
    expect(parsePushSubscription(subscription)).toMatchObject({ endpoint: subscription.endpoint, auth: subscription.keys.auth, expires_at: null });
    expect(() => parsePushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } })).toThrow("neplatný");
    expect(() => parsePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: "secret" } })).toThrow("neplatný");
    expect(() => parsePushSubscription({ ...subscription, expirationTime: Date.now() - 1 })).toThrow("vypršal");
  });

  it("does not advertise malformed or mismatched VAPID config", async () => {
    const { db, rpc } = database([]);
    expect(await getPushConfig(db)).not.toBeNull();
    vi.stubEnv("VAPID_PRIVATE_KEY", randomBytes(32).toString("base64url"));
    expect(await getPushConfig(db)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("server-only Vault configuration", () => {
  const config = {
    publicKey: key.getPublicKey().toString("base64url"),
    privateKey: key.getPrivateKey().toString("base64url"),
    subject: "https://test.dispecing.linkapomoci.sk",
  };
  function clearVapidEnvironment() {
    vi.stubEnv("VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    vi.stubEnv("VAPID_SUBJECT", undefined);
  }

  it("uses the fixed no-argument Vault RPC only when all VAPID env variables are absent", async () => {
    clearVapidEnvironment();
    const { db, rpc, queries } = database([], { data: config });
    expect(await getPushConfig(db)).toEqual(config);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("motorist_get_web_push_config", {});
    expect(queries).toEqual([]);
  });

  it.each(["", " ", "invalid", config.publicKey])("fails closed for any explicitly configured partial env: %j", async (publicKey) => {
    clearVapidEnvironment();
    vi.stubEnv("VAPID_PUBLIC_KEY", publicKey);
    const { db, rpc } = database([], { data: config });
    expect(await getPushConfig(db)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([null, [], "not-an-object", { publicKey: config.publicKey }, { ...config, privateKey: "invalid" }, { ...config, subject: "javascript:alert(1)" }])("fails closed for malformed or missing Vault values: %j", async (data) => {
    clearVapidEnvironment();
    const { db } = database([], { data });
    expect(await getPushConfig(db)).toBeNull();
  });

  it("does not expose private configuration or Vault metadata in device status", async () => {
    clearVapidEnvironment();
    const { db } = database([{ data: [] }], { data: { ...config, unrelatedSecret: "private-metadata" } });
    const status = await getPushSubscriptionStatus(db, actor);
    expect(status).toMatchObject({ configured: true, publicKey: config.publicKey, subscribed: false, soundEnabled: true, callNotificationsConfigured: true });
    expect(JSON.stringify(status)).not.toContain(config.privateKey);
    expect(JSON.stringify(status)).not.toContain("private-metadata");
  });

  it("keeps RPC denial/errors and their potentially sensitive details out of browser responses and logs", async () => {
    clearVapidEnvironment();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, rpc } = database([], { error: { code: "42501", message: "secret-database-detail" } });
    expect(await getPushSubscriptionStatus(db, actor)).toMatchObject({ configured: false, publicKey: null, subscribed: false, soundEnabled: true, callNotificationsConfigured: false });
    rpc.mockRejectedValueOnce(new Error("secret-transport-detail"));
    expect(await getPushConfig(db)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("subscription ownership", () => {
  it("derives all stored ownership from the authenticated actor", async () => {
    const { db, queries } = database([{}, {}]);
    await savePushSubscription(db, actor, { ...subscription, profile_id: "victim", organization_id: "other" }, true);
    const insert = queries[1].operations.find((op) => op.name === "insert");
    expect(insert?.args[0]).toMatchObject({ profile_id: actor.profileId, organization_id: actor.organizationId });
    expect(queries[0].operations).toEqual(expect.arrayContaining([
      { name: "eq", args: ["organization_id", actor.organizationId] }, { name: "eq", args: ["profile_id", actor.profileId] },
    ]));
  });

  it("does not overwrite an endpoint belonging to another account", async () => {
    const { db, queries } = database([{}, { error: { code: "23505", message: "endpoint already exists" } }, {}]);
    await expect(savePushSubscription(db, actor, subscription, true)).rejects.toMatchObject({ status: 409 });
    expect(queries.every((query) => !query.operations.some((op) => op.name === "upsert"))).toBe(true);
  });

  it("removes only the actor's subscription and never updates another profile's sound", async () => {
    const { db, queries } = database([{}, {}]);
    await deletePushSubscription(db, actor, row.endpoint);
    await expect(updatePushSound(db, actor, row.endpoint, false)).rejects.toMatchObject({ status: 404 });
    for (const query of queries) expect(query.operations).toEqual(expect.arrayContaining([
      { name: "eq", args: ["organization_id", actor.organizationId] }, { name: "eq", args: ["profile_id", actor.profileId] },
    ]));
  });

  it("returns settings without subscription endpoint, encryption keys or private VAPID key", async () => {
    const { db } = database([{ data: row }]);
    const status = await getPushSubscriptionStatus(db, actor, row.endpoint);
    expect(status).toMatchObject({ configured: true, subscribed: true, soundEnabled: false });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(row.endpoint);
    expect(serialized).not.toContain(row.auth);
    expect(serialized).not.toContain(key.getPrivateKey().toString("base64url"));
  });

  it("never sends a test to an endpoint absent from the current actor's subscriptions", async () => {
    const { db } = database([{}]);
    await expect(sendTestPush(db, actor, row.endpoint)).rejects.toMatchObject({ status: 404 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("claims test cooldown atomically before contacting the provider", async () => {
    const { db, queries } = database([{ data: row }, {}]);
    await expect(sendTestPush(db, actor, row.endpoint)).rejects.toMatchObject({ status: 429 });
    expect(queries[1].operations.some((op) => op.name === "or" && String(op.args[0]).startsWith("last_test_at.is.null,last_test_at.lt."))).toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("task push delivery", () => {
  it("awaits all opted-in devices, includes sound preference and a stable notification topic", async () => {
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [row, { ...row, id: "sub-b", sound_enabled: true }] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 2, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(firstPayload).toMatchObject({ url: "/?task=task-a", notificationId: "notification-a", soundEnabled: false });
    expect(JSON.parse(sendNotification.mock.calls[1][1]).soundEnabled).toBe(true);
    expect(sendNotification.mock.calls[0][2]).toMatchObject({ timeout: 5000, TTL: 3600, urgency: "high" });
    expect(sendNotification.mock.calls[0][2].topic).toBe(sendNotification.mock.calls[1][2].topic);
    expect(queries[1].operations).toEqual(expect.arrayContaining([{ name: "eq", args: ["profile_id", actor.profileId] }]));
  });

  it.each([404, 410])("cleans up expired subscriptions on provider %s", async (statusCode) => {
    sendNotification.mockRejectedValue({ statusCode, body: "secret provider details", endpoint: row.endpoint });
    const { db, queries } = database([{ data: { id: actor.profileId } }, { data: [row] }, {}]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(queries[2].operations).toEqual(expect.arrayContaining([{ name: "delete", args: [] }, { name: "eq", args: ["id", row.id] }]));
  });

  it.each([{ statusCode: 503 }, { code: "ETIMEDOUT" }, new Error("Socket timeout")])("retries transient failures once with the identical collapse topic: %j", async (error) => {
    sendNotification.mockRejectedValueOnce(error).mockResolvedValueOnce({ statusCode: 201 });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [row] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 1, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0]).toEqual(sendNotification.mock.calls[1]);
  });

  it.each([401, 403])("does not retry authentication failure %s", async (statusCode) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendNotification.mockRejectedValue({ statusCode });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [row] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("honors a bounded provider Retry-After", async () => {
    sendNotification.mockRejectedValueOnce({ statusCode: 429, headers: { "retry-after": "0.1" } }).mockResolvedValueOnce({ statusCode: 201 });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [row] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 1, failed: 0 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it.each(["60", "invalid", "", undefined])("declines unbounded or missing provider backoff: %s", async (retryAfter) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendNotification.mockRejectedValue({ statusCode: 429, headers: { "retry-after": retryAfter } });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [row] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("isolates transient provider errors from saved tasks and never logs credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendNotification.mockRejectedValue({ statusCode: 503, body: "secret-provider-body", endpoint: row.endpoint });
    const { db } = database([{ data: { id: actor.profileId } }, { data: [row] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-provider-body|device-token/);
  });

  it("tolerates an unapplied migration without breaking saved tasks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = database([{ data: { id: actor.profileId } }, { error: { code: "42P01", message: "missing table" } }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refuses unsafe stored endpoints as well as unsafe enrollment", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = database([{ data: { id: actor.profileId } }, { data: [{ ...row, endpoint: "https://localhost/internal" }] }]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 1 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not send private content to deactivated users or unassigned team notifications", async () => {
    const { db } = database([{}]);
    expect(await sendTaskPush(db, message)).toEqual({ sent: 0, failed: 0 });
    expect(await sendTaskPush(db, { ...message, recipientProfileId: null })).toEqual({ sent: 0, failed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
