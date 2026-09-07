import "server-only";

import { createECDH, createHash, ECDH } from "node:crypto";
import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type SubscriptionRow = Database["public"]["Tables"]["motorist_push_subscriptions"]["Row"];
export type PushActor = { organizationId: string; profileId: string };
type PushConfig = { publicKey: string; privateKey: string; subject: string };
type PushMessage = { title: string; body: string; url: string; tag: string; notificationId?: string; taskId?: string; callSessionId?: string; callKind?: "incoming_call" | "available_call"; expiresAt?: string };
type PushResult = "sent" | "expired" | "skipped" | "failed";
const CALL_DELIVERY_BUDGET_MS = 5_000;
const CALL_DELIVERY_CONCURRENCY = 10;
const MIN_CALL_RETRY_WINDOW_MS = 500;
const PREFERENCE_COLUMNS = {
  taskNotificationsEnabled: "task_notifications_enabled",
  incomingCallsEnabled: "incoming_calls_enabled",
  availableCallsEnabled: "available_calls_enabled",
} as const;
type PreferenceKey = keyof typeof PREFERENCE_COLUMNS;
type PreferencePatch = Partial<Pick<SubscriptionRow, typeof PREFERENCE_COLUMNS[PreferenceKey] | "sound_enabled">>;
const DEFAULT_PREFERENCES = { taskNotificationsEnabled: true, incomingCallsEnabled: true, availableCallsEnabled: true };

export class PushError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function getPushConfig(supabase: AdminClient, signal?: AbortSignal): Promise<PushConfig | null> {
  const environment = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  // Even an explicitly empty/partial env configuration takes precedence. Never
  // silently switch signing identities when a deployment's configuration is bad.
  if (Object.values(environment).some((value) => value !== undefined)) return parsePushConfig(environment);
  try {
    // This no-argument RPC is executable only by service_role and reads exactly
    // one named Vault secret. No private values are sent to the browser or logs.
    const request = supabase.rpc("motorist_get_web_push_config", {});
    const result = await (signal ? request.abortSignal(signal) : request);
    return result.error ? null : parsePushConfig(result.data);
  } catch { return null; }
}

function parsePushConfig(value: unknown): PushConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const publicKey = typeof input.publicKey === "string" ? input.publicKey.trim() : null;
  const privateKey = typeof input.privateKey === "string" ? input.privateKey.trim() : null;
  const subject = typeof input.subject === "string" ? input.subject.trim() : null;
  if (!publicKey || !privateKey || !subject) return null;
  try {
    const contact = new URL(subject);
    if (!["https:", "mailto:"].includes(contact.protocol) || (contact.protocol === "mailto:" && !contact.pathname.includes("@"))) return null;
    const key = createECDH("prime256v1");
    key.setPrivateKey(decodeKey(privateKey, 32));
    if (!key.getPublicKey().equals(decodeKey(publicKey, 65))) return null;
    return { publicKey, privateKey, subject };
  } catch { return null; }
}

/** Only browser vendors' HTTPS push services are outbound destinations. */
export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new PushError("Neplatná adresa push odberu.", 400);
  let url: URL;
  try { url = new URL(value); } catch { throw new PushError("Neplatná adresa push odberu.", 400); }
  const host = url.hostname;
  const trusted = host === "fcm.googleapis.com"
    || host === "updates.push.services.mozilla.com"
    || /^(?:[a-z0-9-]+\.)?push\.apple\.com$/.test(host)
    || /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/.test(host);
  if (!trusted || url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.pathname === "/") {
    throw new PushError("Tento prehliadač neposkytol podporovanú adresu push odberu.", 400);
  }
  return url.href;
}

export function parsePushSubscription(value: unknown) {
  if (!value || typeof value !== "object") throw new PushError("Chýba push odber zariadenia.", 400);
  const input = value as { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = validatePushEndpoint(input.endpoint);
  try {
    const p256dh = decodeKey(input.keys?.p256dh, 65);
    if (p256dh[0] !== 4) throw new Error("Uncompressed key required");
    ECDH.convertKey(p256dh, "prime256v1");
    const auth = decodeKey(input.keys?.auth, 16);
    const expiration = input.expirationTime;
    if (expiration != null && (typeof expiration !== "number" || !Number.isFinite(expiration) || expiration <= Date.now() || expiration > 8.64e15)) {
      throw new Error("Invalid expiration");
    }
    return { endpoint, p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url"), expires_at: typeof expiration === "number" ? new Date(expiration).toISOString() : null };
  } catch { throw new PushError("Push odber je neplatný alebo už vypršal. Zapnite ho znova.", 400); }
}

export async function getPushSubscriptionStatus(supabase: AdminClient, actor: PushActor, endpoint?: string | null) {
  const config = await getPushConfig(supabase);
  const result = { configured: Boolean(config), publicKey: config?.publicKey ?? null, subscribed: false, soundEnabled: true, ...DEFAULT_PREFERENCES, callNotificationsConfigured: false };
  if (!endpoint) {
    if (config) result.callNotificationsConfigured = await pushPreferencesConfigured(supabase, actor);
    return result;
  }
  const subscription = await findSubscription(supabase, actor, validatePushEndpoint(endpoint));
  if (!subscription || isExpired(subscription)) {
    if (config) result.callNotificationsConfigured = await pushPreferencesConfigured(supabase, actor);
    return result;
  }
  return {
    ...result, subscribed: true, soundEnabled: subscription.sound_enabled, clientKind: subscription.client_kind ?? "unknown",
    taskNotificationsEnabled: subscription.task_notifications_enabled !== false,
    incomingCallsEnabled: subscription.incoming_calls_enabled !== false,
    availableCallsEnabled: subscription.available_calls_enabled !== false,
    callNotificationsConfigured: Object.values(PREFERENCE_COLUMNS).every((key) => typeof subscription[key] === "boolean"),
  };
}

async function pushPreferencesConfigured(supabase: AdminClient, actor: PushActor): Promise<boolean> {
  const schema = await supabase.from("motorist_push_subscriptions")
    .select("task_notifications_enabled,incoming_calls_enabled,available_calls_enabled")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).limit(1);
  if (schema.error && !missingPreferences(schema.error)) assertStorage(schema.error);
  return !schema.error;
}

export async function savePushSubscription(supabase: AdminClient, actor: PushActor, input: unknown, soundEnabled: unknown, preferences?: unknown) {
  if (!(await getPushConfig(supabase))) throw new PushError("Push notifikácie ešte nie sú nakonfigurované.", 503);
  if (typeof soundEnabled !== "boolean") throw new PushError("Chýba nastavenie zvuku.", 400);
  const choices = parsePreferencePatch(preferences ?? {});
  const subscription = parsePushSubscription(input);
  const kind = preferences && typeof preferences === "object" ? (preferences as Record<string, unknown>).clientKind : undefined;
  if (kind !== undefined && kind !== "web" && kind !== "mobile_app") throw new PushError("Neplatný typ aplikácie.", 400);
  // Only an explicit installed-app registration upgrades the shared endpoint.
  // A subsequent browser read/enrollment must never downgrade that channel.
  const classification = kind === "mobile_app" ? { client_kind: "mobile_app" as const } : {};
  const update = await supabase.from("motorist_push_subscriptions")
    .update({ ...subscription, ...choices, ...classification, sound_enabled: soundEnabled })
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", subscription.endpoint)
    .select("id").maybeSingle();
  assertStorage(update.error);
  if (update.data) return;
  const insert = await supabase.from("motorist_push_subscriptions").insert({
    ...subscription, ...choices, client_kind: kind === "mobile_app" ? "mobile_app" : kind === "web" ? "web" : "unknown", organization_id: actor.organizationId, profile_id: actor.profileId, sound_enabled: soundEnabled,
  });
  // An endpoint cannot be transferred to another account, even by a crafted request.
  if (insert.error?.code === "23505") {
    const own = await findSubscription(supabase, actor, subscription.endpoint);
    if (own) return; // Concurrent enrollment of the same device/account.
    throw new PushError("Tento odber patrí inému prihláseniu. Obnovte povolenie notifikácií v prehliadači.", 409);
  }
  assertStorage(insert.error);
}

export async function deletePushSubscription(supabase: AdminClient, actor: PushActor, endpoint: unknown) {
  const result = await supabase.from("motorist_push_subscriptions").delete()
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", validatePushEndpoint(endpoint));
  assertStorage(result.error);
}

export async function updatePushSound(supabase: AdminClient, actor: PushActor, endpoint: unknown, soundEnabled: unknown) {
  if (typeof soundEnabled !== "boolean") throw new PushError("Neplatné nastavenie zvuku.", 400);
  return updatePushPreferences(supabase, actor, endpoint, { soundEnabled });
}

export async function updatePushPreferences(supabase: AdminClient, actor: PushActor, endpoint: unknown, input: unknown) {
  const patch: PreferencePatch & { client_kind?: "mobile_app" } = parsePreferencePatch(input);
  if (input && typeof input === "object" && (input as Record<string, unknown>).clientKind === "mobile_app") patch.client_kind = "mobile_app";
  if (!Object.keys(patch).length) throw new PushError("Chýba nastavenie upozornení.", 400);
  const result = await supabase.from("motorist_push_subscriptions").update(patch)
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", validatePushEndpoint(endpoint))
    .select("id").maybeSingle();
  assertStorage(result.error);
  if (!result.data) throw new PushError("Najprv zapnite push notifikácie na tomto zariadení.", 404);
}

function parsePreferencePatch(input: unknown): PreferencePatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PushError("Neplatné nastavenie upozornení.", 400);
  const values = input as Record<string, unknown>;
  const patch: PreferencePatch = {};
  for (const [name, column] of Object.entries({ ...PREFERENCE_COLUMNS, soundEnabled: "sound_enabled" } as const)) {
    if (!(name in values)) continue;
    if (typeof values[name] !== "boolean") throw new PushError("Neplatné nastavenie upozornení.", 400);
    patch[column] = values[name];
  }
  return patch;
}

function missingPreferences(error: { code?: string; message?: string }): boolean {
  return ["42703", "PGRST204"].includes(error.code ?? "") && Object.values(PREFERENCE_COLUMNS).some((column) => error.message?.includes(column));
}

export async function sendTestPush(supabase: AdminClient, actor: PushActor, endpoint: unknown) {
  const config = await getPushConfig(supabase);
  if (!config) throw new PushError("Push notifikácie ešte nie sú nakonfigurované.", 503);
  const subscription = await findSubscription(supabase, actor, validatePushEndpoint(endpoint));
  if (!subscription) throw new PushError("Najprv zapnite push notifikácie na tomto zariadení.", 404);
  const now = new Date();
  // Durable per-device cooldown works across Vercel instances, including simultaneous requests.
  const claim = await supabase.from("motorist_push_subscriptions").update({ last_test_at: now.toISOString() })
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("id", subscription.id)
    .or(`last_test_at.is.null,last_test_at.lt.${new Date(now.getTime() - 30_000).toISOString()}`)
    .select("id").maybeSingle();
  assertStorage(claim.error);
  if (!claim.data) throw new PushError("Ďalšiu skúšobnú notifikáciu môžete poslať o 30 sekúnd.", 429);
  const result = await deliverPush(supabase, subscription, {
    title: "Skúška notifikácií", body: "Push notifikácie sú zapnuté. Takto sa zobrazia upozornenia, ktoré ste si povolili.",
    url: "/", tag: `push-test-${now.getTime()}`,
  }, config);
  if (result === "expired") throw new PushError("Push odber vypršal. Vypnite a znova zapnite notifikácie.", 410);
  if (result !== "sent") throw new PushError("Push služba notifikáciu neprijala. Skúste to o chvíľu znova.", 502);
}

/** Called only after a new deduplicated in-app notification has been saved. */
export async function sendTaskPush(supabase: AdminClient, input: {
  organizationId: string; recipientProfileId: string | null; notificationId: string; taskId: string; title: string; body: string;
}): Promise<{ sent: number; failed: number }> {
  const totals = { sent: 0, failed: 0 };
  if (!input.recipientProfileId) return totals;
  const config = await getPushConfig(supabase);
  if (!config) return totals;
  try {
    // Deactivated users must never continue receiving private task content.
    const profile = await supabase.from("motorist_profiles").select("id")
      .eq("organization_id", input.organizationId).eq("id", input.recipientProfileId).eq("active", true).maybeSingle();
    assertStorage(profile.error);
    if (!profile.data) return totals;
    const result = await supabase.from("motorist_push_subscriptions").select("*")
      .eq("organization_id", input.organizationId).eq("profile_id", input.recipientProfileId);
    assertStorage(result.error);
    const message = {
      title: input.title.slice(0, 160), body: input.body.slice(0, 400),
      url: `/?task=${encodeURIComponent(input.taskId)}`, tag: `notification-${input.notificationId}`,
      notificationId: input.notificationId, taskId: input.taskId,
    };
    // Small batches bound outbound concurrency without leaving unawaited work in a serverless request.
    const subscriptions = (result.data ?? []).filter((row) => row.task_notifications_enabled !== false);
    for (let offset = 0; offset < subscriptions.length; offset += 10) {
      const deliveries = await Promise.all(subscriptions.slice(offset, offset + 10).map((row) => deliverPush(supabase, row, message, config)));
      for (const delivery of deliveries) {
        if (delivery === "sent") totals.sent += 1;
        if (delivery === "failed") totals.failed += 1;
      }
    }
    if (totals.failed) console.warn("Task push delivery incomplete", { notificationId: input.notificationId, failed: totals.failed });
  } catch {
    // Never report a saved task as failed or log endpoint credentials/provider response bodies.
    console.warn("Task push delivery unavailable", { notificationId: input.notificationId });
    totals.failed += 1;
  }
  return totals;
}

/** One short-lived call alert per recipient/category/session, independent of
 * repeated webhooks and routing ticks. Claim only when a device opted in. */
export async function sendCallPush(supabase: AdminClient, input: {
  organizationId: string; recipientProfileId: string; sessionId: string;
  category: "incoming_call" | "available_call"; title: string; body: string; expiresAt: string;
}): Promise<{ sent: number; failed: number }> {
  const totals = { sent: 0, failed: 0 };
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return totals;
  const deadlineAt = Date.now() + CALL_DELIVERY_BUDGET_MS;
  const signal = AbortSignal.timeout(CALL_DELIVERY_BUDGET_MS);
  const config = await getPushConfig(supabase, signal);
  if (!config) return totals;
  try {
    const profile = await supabase.from("motorist_profiles").select("id")
      .eq("organization_id", input.organizationId).eq("id", input.recipientProfileId).eq("active", true).abortSignal(signal).maybeSingle();
    assertStorage(profile.error);
    if (!profile.data) return totals;
    const result = await supabase.from("motorist_push_subscriptions").select("*")
      .eq("organization_id", input.organizationId).eq("profile_id", input.recipientProfileId).abortSignal(signal);
    assertStorage(result.error);
    const column = input.category === "incoming_call" ? "incoming_calls_enabled" : "available_calls_enabled";
    // Missing migration fails closed for new categories while task push remains usable.
    const subscriptions = (result.data ?? []).filter((row) => row[column] === true && !isExpired(row));
    if (!subscriptions.length || Date.now() >= expires) return totals;
    const claim = await supabase.from("motorist_notifications").upsert({
      organization_id: input.organizationId, recipient_profile_id: input.recipientProfileId,
      case_id: null, task_id: null, visibility: "private", kind: "system", severity: "info",
      status: "archived", archived_at: new Date().toISOString(), delivery_status: "in_app",
      title: input.title.slice(0, 160), body: input.body.slice(0, 400),
      dedupe_key: `call-push:${input.sessionId}:${input.recipientProfileId}:${input.category}`,
      payload: { source: "call_push", channel: "push", session_id: input.sessionId, category: input.category, expires_at: input.expiresAt },
    }, { onConflict: "organization_id,dedupe_key", ignoreDuplicates: true }).select("id").abortSignal(signal).maybeSingle();
    if (claim.error?.code === "23505") return totals;
    assertStorage(claim.error);
    if (!claim.data) return totals;
    const message: PushMessage = {
      title: input.title.slice(0, 160), body: input.body.slice(0, 300),
      url: `/?call=${encodeURIComponent(input.sessionId)}`, tag: `call-${input.sessionId}`,
      callSessionId: input.sessionId, callKind: input.category, expiresAt: input.expiresAt,
    };
    // Bound concurrency and elapsed work, not the number of registered devices.
    // Account for any remaining devices if the deadline prevents another batch.
    for (let offset = 0; offset < subscriptions.length; offset += CALL_DELIVERY_CONCURRENCY) {
      if (Date.now() >= deadlineAt || Date.now() >= expires) {
        totals.failed += subscriptions.length - offset;
        break;
      }
      const deliveries = await Promise.all(subscriptions.slice(offset, offset + CALL_DELIVERY_CONCURRENCY).map((row) => deliverPush(supabase, row, message, config, {
        expiresAt: expires, deadlineAt, maxTtl: 30, timeout: 2_000, signal,
        refresh: async () => {
          // A device may have been deleted or opted out while the claim, a
          // previous batch, or a provider backoff was pending. Recheck the
          // exact owned row and use its current sound/encryption settings.
          const current = await supabase.from("motorist_push_subscriptions").select("*")
            .eq("organization_id", input.organizationId).eq("profile_id", input.recipientProfileId)
            .eq("id", row.id).eq("endpoint", row.endpoint).eq(column, true).abortSignal(signal).maybeSingle();
          assertStorage(current.error);
          if (current.data?.[column] !== true) return null;
          if (current.data.client_kind === "mobile_app" && !await mobileCallPushEnabled(supabase, { organizationId: input.organizationId, profileId: input.recipientProfileId }, signal)) return null;
          return current.data;
        },
      })));
      for (const delivery of deliveries) {
        if (delivery === "sent") totals.sent++;
        if (delivery === "failed") totals.failed++;
      }
    }
    if (totals.failed) console.warn("Call push delivery incomplete", { sessionId: input.sessionId, failed: totals.failed });
  } catch {
    console.warn("Call push delivery unavailable", { sessionId: input.sessionId });
    totals.failed++;
  }
  return totals;
}

async function deliverPush(supabase: AdminClient, subscription: SubscriptionRow, message: PushMessage, config: PushConfig, options?: {
  expiresAt: number; deadlineAt: number; maxTtl: number; timeout: number; signal: AbortSignal;
  refresh: () => Promise<SubscriptionRow | null>;
}): Promise<PushResult> {
  try {
    const send = async (): Promise<PushResult> => {
      if (options) {
        if (options.expiresAt <= Date.now()) return "expired";
        if (options.deadlineAt <= Date.now()) return "failed";
        const current = await options.refresh();
        if (!current) return "skipped";
        subscription = current;
        if (options.expiresAt <= Date.now()) return "expired";
        if (options.deadlineAt <= Date.now()) return "failed";
      }
      if (isExpired(subscription)) { await removeExpired(supabase, subscription, options?.signal); return "expired"; }
      const endpoint = validatePushEndpoint(subscription.endpoint);
      await webpush.sendNotification({ endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify({ ...message, soundEnabled: subscription.sound_enabled, ...(subscription.client_kind === "mobile_app" ? { mobileApp: true } : {}) }), {
          vapidDetails: config,
          TTL: options ? Math.max(0, Math.min(options.maxTtl, Math.floor((options.expiresAt - Date.now()) / 1000))) : 60 * 60,
          urgency: "high", timeout: options ? Math.max(1, Math.min(options.timeout, options.deadlineAt - Date.now(), options.expiresAt - Date.now())) : 5_000,
          topic: createHash("sha256").update(message.tag).digest("base64url").slice(0, 32),
        });
      return "sent";
    };
    try {
      return await send();
    } catch (error) {
      const delay = retryDelay(error);
      if (delay === null) throw error;
      if (options && Math.min(options.deadlineAt, options.expiresAt) - Date.now() < delay + MIN_CALL_RETRY_WINDOW_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Retry only once, using the same Web Push topic and notification tag.
      // Call retries also recheck expiry and the current device preference.
      return await send();
    }
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
    if (status === 404 || status === 410) {
      try { await removeExpired(supabase, subscription, options?.signal); } catch { /* No sensitive provider errors in logs. */ }
      return "expired";
    }
    return "failed";
  }
}

function retryDelay(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as { statusCode?: number; code?: string; message?: string; headers?: Record<string, unknown> };
  if (failure.statusCode === 429) {
    const retryAfter = failure.headers?.["retry-after"];
    if (typeof retryAfter !== "string") return null;
    const seconds = Number(retryAfter);
    const delay = retryAfter.trim() !== "" && Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    // Respect longer provider backoff by declining an immediate retry.
    return Number.isFinite(delay) && delay >= 0 && delay <= 1000 ? delay : null;
  }
  if (failure.statusCode && failure.statusCode >= 500 && failure.statusCode <= 599) return 250;
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(failure.code ?? "") || failure.message === "Socket timeout") return 250;
  return null;
}

async function findSubscription(supabase: AdminClient, actor: PushActor, endpoint: string) {
  const result = await supabase.from("motorist_push_subscriptions").select("*")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", endpoint).maybeSingle();
  assertStorage(result.error);
  return result.data;
}

async function removeExpired(supabase: AdminClient, subscription: SubscriptionRow, signal?: AbortSignal) {
  const request = supabase.from("motorist_push_subscriptions").delete()
    .eq("organization_id", subscription.organization_id).eq("profile_id", subscription.profile_id).eq("id", subscription.id);
  const result = await (signal ? request.abortSignal(signal) : request);
  assertStorage(result.error);
}

function isExpired(subscription: SubscriptionRow) {
  return subscription.expires_at !== null && new Date(subscription.expires_at).getTime() <= Date.now();
}

function decodeKey(value: unknown, bytes: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 100) throw new Error("Invalid key");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes) throw new Error("Invalid key length");
  return decoded;
}

function assertStorage(error: unknown) {
  if (error) throw new PushError("Nastavenie push notifikácií sa nepodarilo uložiť alebo načítať.", 503);
}

/** Account-level gate applies only to mobile call alerts, never tasks or desktop. */
export async function mobileCallPushEnabled(supabase: AdminClient, actor: PushActor, signal?: AbortSignal): Promise<boolean> {
  let query = supabase.from("motorist_call_notification_preferences").select("mobile_calls_enabled")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId);
  if (signal) query = query.abortSignal(signal);
  const result = await query.maybeSingle();
  assertStorage(result.error);
  return result.data?.mobile_calls_enabled !== false;
}

export async function getMobileCallPushSettings(supabase: AdminClient, actor: PushActor) {
  const enabled = await mobileCallPushEnabled(supabase, actor);
  const devices = await supabase.from("motorist_push_subscriptions").select("*")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("client_kind", "mobile_app");
  assertStorage(devices.error);
  return { enabled, mobileApps: (devices.data ?? []).filter((row) => !isExpired(row) && (row.incoming_calls_enabled || row.available_calls_enabled)).length };
}

export async function setMobileCallPushSettings(supabase: AdminClient, actor: PushActor, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PushError("Neplatné nastavenie mobilných upozornení.", 400);
  const result = await supabase.from("motorist_call_notification_preferences").upsert({
    organization_id: actor.organizationId, profile_id: actor.profileId, mobile_calls_enabled: enabled, updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id,profile_id" });
  assertStorage(result.error);
  return getMobileCallPushSettings(supabase, actor);
}
