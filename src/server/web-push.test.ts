import { createECDH, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import {
  deletePushSubscription, getPushConfig, getPushSubscriptionStatus, parsePushSubscription,
  savePushSubscription, sendTaskPush, sendTestPush, updatePushSound, validatePushEndpoint,
} from "./web-push";

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ default: { sendNotification } }));

type DbResult = { data?: unknown; error?: { code?: string; message: string } | null };
function database(results: DbResult[], configResult: DbResult = { data: null }) {
  const queries: { table: string; operations: { name: string; args: unknown[] }[] }[] = [];
  const rpc = vi.fn().mockResolvedValue({ error: null, ...configResult });
  const db = {
    rpc,
    from(table: string) {
      const result = results.shift();
      if (!result) throw new Error(`Unexpected query: ${table}`);
      const operations: { name: string; args: unknown[] }[] = [];
      queries.push({ table, operations });
      const chain = new Proxy({}, { get(_target, name: string) {
        if (name === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null, ...result }).then(resolve);
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

beforeEach(() => {
  vi.stubEnv("VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("VAPID_SUBJECT", "https://test.dispecing.linkapomoci.sk");
  sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
    const { db } = database([], { data: { ...config, unrelatedSecret: "private-metadata" } });
    const status = await getPushSubscriptionStatus(db, actor);
    expect(status).toEqual({ configured: true, publicKey: config.publicKey, subscribed: false, soundEnabled: true });
    expect(JSON.stringify(status)).not.toContain(config.privateKey);
    expect(JSON.stringify(status)).not.toContain("private-metadata");
  });

  it("keeps RPC denial/errors and their potentially sensitive details out of browser responses and logs", async () => {
    clearVapidEnvironment();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, rpc } = database([], { error: { code: "42501", message: "secret-database-detail" } });
    expect(await getPushSubscriptionStatus(db, actor)).toEqual({ configured: false, publicKey: null, subscribed: false, soundEnabled: true });
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
