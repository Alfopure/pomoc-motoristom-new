import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { MobilePushData, MobilePushPayload, MobilePushPreferences, MobilePushType } from "@/lib/mobile-api";
import type { Database, Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { humansOnly } from "@/server/profile-kind";
import { mobileEnvironment } from "./auth";

/** Push notifications of the native app, delivered through the Expo push service
 * (Apple APNs underneath). Texts never carry customer data: a case number at most.
 * Switched on per Vercel project with MOBILE_PUSH_ENABLED; production stays off
 * until its own approval, and a database without the table simply sends nothing. */
type Admin = SupabaseClient<Database>;
export type PushTransport = (input: string, init: RequestInit) => Promise<Response>;
export const MOBILE_PUSH_TYPES: readonly MobilePushType[] = ["tasks", "task_due", "callbacks_mine", "callbacks_unclaimed", "cases"];
const TABLE = "motorist_mobile_push_devices";
const TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
/** The app registers again at every start; a phone unused for this long is left alone. */
const STALE_DEVICE_DAYS = 30;
/** Every database read of a delivery is bounded; a slow database skips the notice. */
const READ_MS = 8_000;

export function mobilePushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOBILE_PUSH_ENABLED === "true";
}
export function defaultPushPreferences(): MobilePushPreferences {
  return { tasks: true, task_due: true, callbacks_mine: true, callbacks_unclaimed: true, cases: true };
}
/** Known switches only; anything else in stored or sent preferences is ignored or refused. */
function storedPreferences(value: unknown): MobilePushPreferences {
  const result = defaultPushPreferences();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const type of MOBILE_PUSH_TYPES) if (typeof (value as Record<string, unknown>)[type] === "boolean") result[type] = (value as Record<string, boolean>)[type];
  }
  return result;
}
const missingTable = (error: { code?: string } | null) => error?.code === "42P01" || error?.code === "PGRST205";
const unavailable = () => new MutationError("Upozornenia ešte nie sú v tomto prostredí pripravené.", 503, "push_unavailable");

export type MobilePushRegistrationInput = {
  installationId: string; token: string; platform: "ios" | "android"; appVersion: string | null; preferences: Partial<MobilePushPreferences> | null;
};
export function readPushRegistration(value: unknown): MobilePushRegistrationInput {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const keys = ["installationId", "token", "platform", "appVersion", "preferences"];
  if (!body || Object.keys(body).some(key => !keys.includes(key)) || typeof body.installationId !== "string" || !isUuid(body.installationId)
    || typeof body.token !== "string" || !TOKEN.test(body.token) || body.platform !== "ios" && body.platform !== "android"
    || body.appVersion !== undefined && body.appVersion !== null && (typeof body.appVersion !== "string" || body.appVersion.length > 40)) {
    throw new MutationError("Neplatná registrácia upozornení.", 400);
  }
  let preferences: Partial<MobilePushPreferences> | null = null;
  if (body.preferences !== undefined && body.preferences !== null) {
    const raw = body.preferences;
    if (typeof raw !== "object" || Array.isArray(raw) || Object.entries(raw as Record<string, unknown>).some(([key, flag]) => !MOBILE_PUSH_TYPES.includes(key as MobilePushType) || typeof flag !== "boolean")) {
      throw new MutationError("Neplatné nastavenie upozornení.", 400);
    }
    preferences = raw as Partial<MobilePushPreferences>;
  }
  return { installationId: body.installationId.toLowerCase(), token: body.token, platform: body.platform, appVersion: typeof body.appVersion === "string" ? body.appVersion : null, preferences };
}

/** Registers this installation for the signed-in operator, or updates its switches.
 * The same phone under another account starts from the defaults, never from the
 * previous user's choices. */
export async function registerMobilePush(admin: Admin, actor: MotoristActor, value: unknown, now = new Date()): Promise<{ preferences: MobilePushPreferences }> {
  if (!mobilePushEnabled()) throw unavailable();
  const input = readPushRegistration(value), environment = mobileEnvironment();
  const existing = await admin.from(TABLE).select("profile_id,organization_id,preferences").eq("environment", environment).eq("installation_id", input.installationId).maybeSingle();
  if (missingTable(existing.error)) throw unavailable();
  if (existing.error) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  const own = existing.data && existing.data.profile_id === actor.profileId && existing.data.organization_id === actor.organizationId;
  const preferences = { ...storedPreferences(own ? existing.data!.preferences : null), ...(input.preferences ?? {}) };
  // A token belongs to one installation only.
  const stale = await admin.from(TABLE).delete().eq("expo_push_token", input.token).neq("installation_id", input.installationId);
  if (stale.error) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  const saved = await admin.from(TABLE).upsert({
    organization_id: actor.organizationId, profile_id: actor.profileId, environment, installation_id: input.installationId,
    expo_push_token: input.token, platform: input.platform, preferences: preferences as unknown as Json, app_version: input.appVersion,
    updated_at: now.toISOString(), last_seen_at: now.toISOString(),
  }, { onConflict: "environment,installation_id" }).select("preferences").single();
  if (saved.error || !saved.data) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  return { preferences: storedPreferences(saved.data.preferences) };
}

/** Removes this installation of the signed-in operator, e.g. at logout. */
export async function unregisterMobilePush(admin: Admin, actor: MotoristActor, value: unknown): Promise<{ removed: boolean }> {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => key !== "installationId") || typeof body.installationId !== "string" || !isUuid(body.installationId)) {
    throw new MutationError("Neplatná požiadavka.", 400);
  }
  const removed = await admin.from(TABLE).delete().eq("environment", mobileEnvironment()).eq("installation_id", body.installationId.toLowerCase())
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).select("id");
  if (missingTable(removed.error)) return { removed: false };
  if (removed.error) throw new MutationError("Upozornenia sa nepodarilo vypnúť.", 503);
  return { removed: (removed.data ?? []).length > 0 };
}

export type PushDevice = { id: string; profileId: string; token: string; preferences: MobilePushPreferences };
export type PushTotals = { sent: number; skipped: number; failed: number };

/** Devices of active dispatching people who want this kind of message. "team"
 * means every such person of the organization with the app installed. */
export async function pushRecipients(admin: Admin, organizationId: string, type: MobilePushType, profileIds: readonly string[] | "team", now = new Date()): Promise<Map<string, PushDevice[]>> {
  const recipients = new Map<string, PushDevice[]>();
  const wanted = profileIds === "team" ? null : [...new Set(profileIds.filter(isUuid))];
  if (wanted && !wanted.length) return recipients;
  let query = admin.from(TABLE).select("id,profile_id,expo_push_token,preferences").eq("organization_id", organizationId).eq("environment", mobileEnvironment())
    .gte("last_seen_at", new Date(now.getTime() - STALE_DEVICE_DAYS * 86_400_000).toISOString());
  if (wanted) query = query.in("profile_id", wanted);
  const devices = await query.limit(500).abortSignal(AbortSignal.timeout(READ_MS));
  if (missingTable(devices.error)) return recipients;
  if (devices.error) throw new Error("push devices unavailable");
  const candidates = (devices.data ?? []).map(row => ({ id: row.id, profileId: row.profile_id, token: row.expo_push_token, preferences: storedPreferences(row.preferences) }))
    .filter(device => device.preferences[type]);
  if (!candidates.length) return recipients;
  // Deactivated or disabled people never keep receiving work notices on an old phone.
  const people = await humansOnly(admin.from("motorist_profiles").select("id").eq("organization_id", organizationId)
    .in("id", [...new Set(candidates.map(device => device.profileId))]).eq("active", true).eq("access_status", "active").in("role", [...ROLES]))
    .abortSignal(AbortSignal.timeout(READ_MS));
  if (people.error) throw new Error("push recipients unavailable");
  const allowed = new Set((people.data ?? []).map(row => row.id));
  for (const device of candidates) if (allowed.has(device.profileId)) recipients.set(device.profileId, [...recipients.get(device.profileId) ?? [], device]);
  return recipients;
}

export type PushClaim = { profileId: string; key: string; type: MobilePushType; title: string; body: string };
const claimKey = (claim: Pick<PushClaim, "key" | "profileId">) => "mobile-push:" + claim.key + ":" + claim.profileId;

/** One archived notification row per recipient and event is the claim; the web
 * never lists archived rows. Returns the claims that are new, so a retry or the
 * next cron pass sends nothing twice. */
export async function claimPushes(admin: Admin, organizationId: string, claims: readonly PushClaim[], now = new Date()): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (!claims.length) return fresh;
  const result = await admin.from("motorist_notifications").upsert(claims.map(claim => ({
    organization_id: organizationId, recipient_profile_id: claim.profileId, case_id: null, task_id: null,
    visibility: "private" as const, kind: "system" as const, severity: "info" as const, status: "archived" as const, archived_at: now.toISOString(), delivery_status: "in_app" as const,
    title: claim.title.slice(0, 160), body: claim.body.slice(0, 400), dedupe_key: claimKey(claim),
    payload: { source: "mobile_push", channel: "mobile_push", type: claim.type } as unknown as Json,
  })), { onConflict: "organization_id,dedupe_key", ignoreDuplicates: true }).select("dedupe_key").abortSignal(AbortSignal.timeout(READ_MS));
  if (result.error) throw new Error("push claim unavailable");
  const inserted = new Set((result.data ?? []).map(row => row.dedupe_key));
  for (const claim of claims) if (inserted.has(claimKey(claim))) fresh.add(claimKey(claim));
  return fresh;
}
export const isClaimed = (fresh: Set<string>, claim: Pick<PushClaim, "key" | "profileId">) => fresh.has(claimKey(claim));

export type PushNotice = { device: PushDevice; title: string; body: string; data: MobilePushData };

/** Expo accepts up to 100 messages per request. A device whose app was removed is forgotten. */
export async function deliverPushNotices(admin: Admin, notices: readonly PushNotice[], transport: PushTransport = fetch): Promise<Pick<PushTotals, "sent" | "failed">> {
  const totals = { sent: 0, failed: 0 };
  const token = process.env.EXPO_ACCESS_TOKEN?.trim();
  for (let offset = 0; offset < notices.length; offset += 100) {
    const batch = notices.slice(offset, offset + 100);
    try {
      const response = await transport(EXPO_SEND, {
        method: "POST", signal: AbortSignal.timeout(6_000),
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify(batch.map(notice => ({ to: notice.device.token, title: notice.title.slice(0, 120), body: notice.body.slice(0, 240),
          data: { ...notice.data, profileId: notice.device.profileId } satisfies MobilePushPayload, sound: "default", priority: "high" }))),
      });
      const result = await response.json().catch(() => null) as { data?: { status?: string; details?: { error?: string } }[] } | null;
      if (!response.ok || !Array.isArray(result?.data) || result.data.length !== batch.length) { totals.failed += batch.length; continue; }
      const gone: string[] = [];
      result.data.forEach((ticket, index) => {
        if (ticket?.status === "ok") totals.sent += 1;
        else { totals.failed += 1; if (ticket?.details?.error === "DeviceNotRegistered") gone.push(batch[index].device.id); }
      });
      if (gone.length) await admin.from(TABLE).delete().in("id", gone).abortSignal(AbortSignal.timeout(READ_MS));
    } catch {
      totals.failed += batch.length;
    }
  }
  return totals;
}

export type MobilePushMessage = {
  organizationId: string; profileIds: readonly string[]; type: MobilePushType;
  title: string; body: string; data: MobilePushData;
  /** Identifies the event; each recipient gets it once. */
  dedupeKey: string;
};

/** Best effort: never throws. Callers in a request use queueMobilePush. */
export async function sendMobilePush(admin: Admin, message: MobilePushMessage, transport: PushTransport = fetch): Promise<PushTotals> {
  const totals: PushTotals = { sent: 0, skipped: 0, failed: 0 };
  if (!mobilePushEnabled() || !message.profileIds.length) return totals;
  try {
    const recipients = await pushRecipients(admin, message.organizationId, message.type, message.profileIds);
    if (!recipients.size) return totals;
    const claims = [...recipients.keys()].map(profileId => ({ profileId, key: message.dedupeKey, type: message.type, title: message.title, body: message.body }));
    const fresh = await claimPushes(admin, message.organizationId, claims);
    const notices: PushNotice[] = [];
    for (const claim of claims) {
      const devices = recipients.get(claim.profileId) ?? [];
      if (isClaimed(fresh, claim)) notices.push(...devices.map(device => ({ device, title: message.title, body: message.body, data: message.data })));
      else totals.skipped += devices.length;
    }
    const delivered = await deliverPushNotices(admin, notices, transport);
    totals.sent += delivered.sent;
    totals.failed += delivered.failed;
  } catch {
    totals.failed += 1;
  }
  if (totals.failed) console.warn(JSON.stringify({ event: "mobile.push", type: message.type, sent: totals.sent, failed: totals.failed }));
  return totals;
}

/** Sends after the response, so a slow push service never delays the work that
 * caused it. Outside a request (tests, scripts) nothing is queued. */
export function queueMobilePush(work: () => Promise<unknown>) {
  if (!mobilePushEnabled()) return;
  try {
    after(async () => { try { await work(); } catch { /* Push is best effort. */ } });
  } catch { /* No request lifecycle means no detached work. */ }
}
