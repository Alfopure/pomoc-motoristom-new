import "server-only";

import { createECDH, createHash, ECDH } from "node:crypto";
import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type SubscriptionRow = Database["public"]["Tables"]["motorist_push_subscriptions"]["Row"];
export type PushActor = { organizationId: string; profileId: string };
type PushConfig = { publicKey: string; privateKey: string; subject: string };
type PushMessage = { title: string; body: string; url: string; tag: string; notificationId?: string; taskId?: string };
type PushResult = "sent" | "expired" | "failed";

export class PushError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function getPushConfig(supabase: AdminClient): Promise<PushConfig | null> {
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
    const result = await supabase.rpc("motorist_get_web_push_config", {});
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
  const result = { configured: Boolean(config), publicKey: config?.publicKey ?? null, subscribed: false, soundEnabled: true };
  if (!endpoint) return result;
  const subscription = await findSubscription(supabase, actor, validatePushEndpoint(endpoint));
  if (!subscription || isExpired(subscription)) return result;
  return { ...result, subscribed: true, soundEnabled: subscription.sound_enabled };
}

export async function savePushSubscription(supabase: AdminClient, actor: PushActor, input: unknown, soundEnabled: unknown) {
  if (!(await getPushConfig(supabase))) throw new PushError("Push notifikácie ešte nie sú nakonfigurované.", 503);
  if (typeof soundEnabled !== "boolean") throw new PushError("Chýba nastavenie zvuku.", 400);
  const subscription = parsePushSubscription(input);
  const update = await supabase.from("motorist_push_subscriptions")
    .update({ ...subscription, sound_enabled: soundEnabled })
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", subscription.endpoint)
    .select("id").maybeSingle();
  assertStorage(update.error);
  if (update.data) return;
  const insert = await supabase.from("motorist_push_subscriptions").insert({
    ...subscription, organization_id: actor.organizationId, profile_id: actor.profileId, sound_enabled: soundEnabled,
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
  const result = await supabase.from("motorist_push_subscriptions").update({ sound_enabled: soundEnabled })
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).eq("endpoint", validatePushEndpoint(endpoint))
    .select("id").maybeSingle();
  assertStorage(result.error);
  if (!result.data) throw new PushError("Najprv zapnite push notifikácie na tomto zariadení.", 404);
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
    title: "Skúška notifikácií", body: "Push notifikácie sú zapnuté. Takto vás upozorníme na pridelenú úlohu.",
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
    const subscriptions = result.data ?? [];
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

async function deliverPush(supabase: AdminClient, subscription: SubscriptionRow, message: PushMessage, config: PushConfig): Promise<PushResult> {
  try {
    if (isExpired(subscription)) { await removeExpired(supabase, subscription); return "expired"; }
    const endpoint = validatePushEndpoint(subscription.endpoint);
    const send = () => webpush.sendNotification({ endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify({ ...message, soundEnabled: subscription.sound_enabled }), {
        vapidDetails: config, TTL: 60 * 60, urgency: "high", timeout: 5_000,
        topic: createHash("sha256").update(message.tag).digest("base64url").slice(0, 32),
      });
    try {
      await send();
    } catch (error) {
      const delay = retryDelay(error);
      if (delay === null) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Retry only once, using the same Web Push topic and notification tag.
      // Providers collapse pending messages; the SW tag replaces an existing alert.
      await send();
    }
    return "sent";
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
    if (status === 404 || status === 410) {
      try { await removeExpired(supabase, subscription); } catch { /* No sensitive provider errors in logs. */ }
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

async function removeExpired(supabase: AdminClient, subscription: SubscriptionRow) {
  const result = await supabase.from("motorist_push_subscriptions").delete()
    .eq("organization_id", subscription.organization_id).eq("profile_id", subscription.profile_id).eq("id", subscription.id);
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
