import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { canOperateTelephony } from "@/lib/app-environment";
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
export const MOBILE_PUSH_TYPES: readonly MobilePushType[] = ["tasks", "task_due", "callbacks_mine", "callbacks_unclaimed", "cases", "handoffs"];
const TABLE = "motorist_mobile_push_devices";
const TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
/** The app registers again at every start; a phone unused for this long is left alone. */
const STALE_DEVICE_DAYS = 30;
/** Every database read of a delivery is bounded; a slow database skips the notice. */
const READ_MS = 8_000;
const CLAIM = "mobile-push:";

/** Same deployment boundary as telephony: never from a working-branch Preview, and
 * on TEST only from the dedicated stable TEST deployment. */
export function mobilePushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOBILE_PUSH_ENABLED === "true" && canOperateTelephony(env);
}
export function defaultPushPreferences(): MobilePushPreferences {
  return { tasks: true, task_due: true, callbacks_mine: true, callbacks_unclaimed: true, cases: true, handoffs: true };
}
/** Known switches only; anything else in stored or sent preferences is ignored. */
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
    const raw = body.preferences as Record<string, unknown>;
    // A switch of a newer app is ignored here; a known one must be on or off.
    if (typeof raw !== "object" || Array.isArray(raw) || MOBILE_PUSH_TYPES.some(type => type in raw && typeof raw[type] !== "boolean")) {
      throw new MutationError("Neplatné nastavenie upozornení.", 400);
    }
    preferences = Object.fromEntries(MOBILE_PUSH_TYPES.filter(type => typeof raw[type] === "boolean").map(type => [type, raw[type]]));
  }
  return { installationId: body.installationId.toLowerCase(), token: body.token, platform: body.platform, appVersion: typeof body.appVersion === "string" ? body.appVersion : null, preferences };
}

/** Whose phone it is: a dispatcher (profile), a pristavovač (field member), or
 * someone who is both and sees both modules in the one app. */
export type PushOwner = { organizationId: string; profileId: string | null; memberId: string | null };
export const pushOwner = (owner: Pick<MotoristActor, "organizationId" | "profileId">): PushOwner => ({ organizationId: owner.organizationId, profileId: owner.profileId, memberId: null });

/** Registers this installation for the signed-in person, or updates its switches.
 * The same phone under another account starts from the defaults, never from the
 * previous user's choices. A dispatcher's registration touches only the columns of
 * the first push migration, so it works before deliveries are installed. */
export async function registerMobilePush(admin: Admin, owner: PushOwner, value: unknown, now = new Date()): Promise<{ preferences: MobilePushPreferences }> {
  if (!mobilePushEnabled()) throw unavailable();
  if (!owner.profileId && !owner.memberId) throw new MutationError("Nemáte prístup k upozorneniam.", 403);
  const input = readPushRegistration(value), environment = mobileEnvironment();
  const member = owner.memberId !== null;
  const existing = await admin.from(TABLE).select(member ? "profile_id,member_id,organization_id,preferences" : "profile_id,organization_id,preferences")
    .eq("environment", environment).eq("installation_id", input.installationId).maybeSingle();
  if (missingTable(existing.error) || member && existing.error?.code === "42703") throw unavailable();
  if (existing.error) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  const row = existing.data as { profile_id: string | null; member_id?: string | null; organization_id: string; preferences: Json } | null;
  // The same person keeps their switches, also when a role was added or removed since.
  const own = row && row.organization_id === owner.organizationId
    && (owner.profileId !== null && row.profile_id === owner.profileId || owner.memberId !== null && row.member_id === owner.memberId);
  const preferences = { ...storedPreferences(own ? row!.preferences : null), ...(input.preferences ?? {}) };
  // Another account's row of this phone goes first: a row names exactly one person.
  if (row && !own) {
    const previous = await admin.from(TABLE).delete().eq("environment", environment).eq("installation_id", input.installationId);
    if (previous.error) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  }
  // A token belongs to one installation only.
  const stale = await admin.from(TABLE).delete().eq("expo_push_token", input.token).neq("installation_id", input.installationId);
  if (stale.error) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  const store = (memberId: string | null) => admin.from(TABLE).upsert({
    organization_id: owner.organizationId, profile_id: owner.profileId, ...(member || row?.member_id !== undefined ? { member_id: memberId } : {}),
    environment, installation_id: input.installationId,
    expo_push_token: input.token, platform: input.platform, preferences: preferences as unknown as Json, app_version: input.appVersion,
    updated_at: now.toISOString(), last_seen_at: now.toISOString(),
  }, { onConflict: "environment,installation_id" }).select("preferences").single();
  let saved = await store(owner.memberId);
  // Before the background migration a phone names one person only: a dispatcher who
  // also delivers keeps the dispatch notices then.
  if (saved.error?.code === "23514" && owner.profileId && owner.memberId) saved = await store(null);
  if (saved.error || !saved.data) throw new MutationError("Upozornenia sa nepodarilo uložiť.", 503);
  return { preferences: storedPreferences(saved.data.preferences) };
}

/** Removes this installation, e.g. at logout. Whoever is signed in on the phone may
 * do it, also for a previous account whose logout never reached the server: only
 * the phone itself knows its random installation identifier. */
export async function unregisterMobilePush(admin: Admin, value: unknown): Promise<{ removed: boolean }> {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => key !== "installationId") || typeof body.installationId !== "string" || !isUuid(body.installationId)) {
    throw new MutationError("Neplatná požiadavka.", 400);
  }
  const removed = await admin.from(TABLE).delete().eq("environment", mobileEnvironment()).eq("installation_id", body.installationId.toLowerCase()).select("id");
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
  // A pristavovač's phone has no profile and never receives dispatch notices.
  const candidates = (devices.data ?? []).flatMap(row => row.profile_id === null ? [] : [{ id: row.id, profileId: row.profile_id, token: row.expo_push_token, preferences: storedPreferences(row.preferences) }])
    .filter(device => device.preferences[type]);
  if (!candidates.length) return recipients;
  // Deactivated or disabled people never keep receiving work notices on an old phone.
  const people = await humansOnly(admin.from("motorist_profiles").select("id").eq("organization_id", organizationId)
    .in("id", [...new Set(candidates.map(device => device.profileId))]).eq("active", true).eq("access_status", "active").in("role", [...ROLES]))
    .abortSignal(AbortSignal.timeout(READ_MS));
  if (people.error) throw new Error("push recipients unavailable");
  const allowed = new Set((people.data ?? []).map(row => row.id));
  for (const device of [...candidates].sort((a, b) => a.profileId.localeCompare(b.profileId))) {
    if (allowed.has(device.profileId)) recipients.set(device.profileId, [...recipients.get(device.profileId) ?? [], device]);
  }
  return recipients;
}

/** Phones of active pristavovači who want delivery notices. The owner id travels in
 * the notice as `profileId`, so the app opens it only in the account it was sent to. */
export async function pushMemberRecipients(admin: Admin, organizationId: string, memberIds: readonly string[], now = new Date()): Promise<Map<string, PushDevice[]>> {
  const recipients = new Map<string, PushDevice[]>();
  const wanted = [...new Set(memberIds.filter(isUuid))];
  if (!wanted.length) return recipients;
  const devices = await (admin as unknown as SupabaseClient).from(TABLE).select("id,member_id,expo_push_token,preferences").eq("organization_id", organizationId)
    .eq("environment", mobileEnvironment()).in("member_id", wanted).gte("last_seen_at", new Date(now.getTime() - STALE_DEVICE_DAYS * 86_400_000).toISOString())
    .limit(100).abortSignal(AbortSignal.timeout(READ_MS));
  if (missingTable(devices.error) || devices.error?.code === "42703") return recipients;
  if (devices.error) throw new Error("push devices unavailable");
  const rows = (devices.data ?? []) as { id: string; member_id: string; expo_push_token: string; preferences: Json }[];
  const candidates = rows.map(row => ({ id: row.id, profileId: row.member_id, token: row.expo_push_token, preferences: storedPreferences(row.preferences) }))
    .filter(device => device.preferences.handoffs);
  if (!candidates.length) return recipients;
  const members = await (admin as unknown as SupabaseClient).from("motorist_towing_memberships").select("id").eq("organization_id", organizationId)
    .in("id", [...new Set(candidates.map(device => device.profileId))]).eq("active", true).contains("capabilities", ["deliver"]).abortSignal(AbortSignal.timeout(READ_MS));
  if (members.error) throw new Error("push recipients unavailable");
  const allowed = new Set(((members.data ?? []) as { id: string }[]).map(row => row.id));
  for (const device of candidates) if (allowed.has(device.profileId)) recipients.set(device.profileId, [...recipients.get(device.profileId) ?? [], device]);
  return recipients;
}

/** A delivery notice to pristavovači. It follows a change that happens once (sending
 * the delivery to them), so no claim is kept; one quick retry, never throws. */
export async function sendMemberPush(admin: Admin, message: { organizationId: string; memberIds: readonly string[]; title: string; body: string; data: MobilePushData },
  transport: PushTransport = fetch, retryAfterMs = 1_500): Promise<PushTotals> {
  const totals: PushTotals = { sent: 0, skipped: 0, failed: 0 };
  if (!mobilePushEnabled() || !message.memberIds.length) return totals;
  try {
    const recipients = await pushMemberRecipients(admin, message.organizationId, message.memberIds);
    const notices = [...recipients.values()].flat().map(device => ({ device, title: message.title, body: message.body, data: message.data }));
    const outcomes = await deliverPushNotices(admin, notices, transport);
    const retry = notices.filter((_, index) => outcomes[index] === "failed");
    if (retry.length) {
      await new Promise(resolve => setTimeout(resolve, retryAfterMs));
      const again = await deliverPushNotices(admin, retry, transport);
      let position = 0;
      outcomes.forEach((outcome, index) => { if (outcome === "failed") outcomes[index] = again[position++]; });
    }
    totals.sent = outcomes.filter(outcome => outcome === "sent").length;
    totals.failed = outcomes.filter(outcome => outcome === "failed").length;
  } catch {
    totals.failed += 1;
  }
  if (totals.failed) console.warn(JSON.stringify({ event: "mobile.push", type: "handoffs", sent: totals.sent, failed: totals.failed }));
  return totals;
}

/** An event announced once: `key` identifies it (per person or per team), `profileId`
 * is whom the archived row names. */
export type PushClaim = { profileId: string; key: string; type: MobilePushType; title: string; body: string };

/** One archived notification row per event is the claim; the web never lists
 * archived rows. Returns the keys that are new, so a retry or the next cron pass
 * sends nothing twice. */
export async function claimPushes(admin: Admin, organizationId: string, claims: readonly PushClaim[], now = new Date()): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (!claims.length) return fresh;
  const result = await admin.from("motorist_notifications").upsert(claims.map(claim => ({
    organization_id: organizationId, recipient_profile_id: claim.profileId, case_id: null, task_id: null,
    visibility: "private" as const, kind: "system" as const, severity: "info" as const, status: "archived" as const, archived_at: now.toISOString(), delivery_status: "in_app" as const,
    title: claim.title.slice(0, 160), body: claim.body.slice(0, 400), dedupe_key: CLAIM + claim.key,
    payload: { source: "mobile_push", channel: "mobile_push", type: claim.type } as unknown as Json,
  })), { onConflict: "organization_id,dedupe_key", ignoreDuplicates: true }).select("dedupe_key").abortSignal(AbortSignal.timeout(READ_MS));
  if (result.error) throw new Error("push claim unavailable");
  for (const row of result.data ?? []) if (row.dedupe_key.startsWith(CLAIM)) fresh.add(row.dedupe_key.slice(CLAIM.length));
  return fresh;
}
/** Which of these events were announced already; read in small pieces to keep each request short. */
export async function claimedEvents(admin: Admin, organizationId: string, keys: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 40) {
    const rows = await admin.from("motorist_notifications").select("dedupe_key").eq("organization_id", organizationId)
      .in("dedupe_key", keys.slice(offset, offset + 40).map(key => CLAIM + key)).abortSignal(AbortSignal.timeout(READ_MS));
    if (rows.error) throw new Error("push claims unavailable");
    for (const row of rows.data ?? []) known.add(row.dedupe_key.slice(CLAIM.length));
  }
  return known;
}
/** A notice that reached nobody may be sent again by a later attempt of the same event. */
export async function releaseClaims(admin: Admin, organizationId: string, keys: readonly string[]) {
  for (let offset = 0; offset < keys.length; offset += 40) {
    await admin.from("motorist_notifications").delete().eq("organization_id", organizationId).eq("status", "archived")
      .in("dedupe_key", keys.slice(offset, offset + 40).map(key => CLAIM + key)).abortSignal(AbortSignal.timeout(READ_MS));
  }
}

export type PushNotice = { device: PushDevice; title: string; body: string; data: MobilePushData };
/** "gone": the app was removed from that phone, so the phone is forgotten. */
export type PushOutcome = "sent" | "gone" | "failed";

/** Expo accepts up to 100 messages per request. Outcomes follow the order of the notices. */
export async function deliverPushNotices(admin: Admin, notices: readonly PushNotice[], transport: PushTransport = fetch): Promise<PushOutcome[]> {
  const outcomes: PushOutcome[] = [];
  const token = process.env.EXPO_ACCESS_TOKEN?.trim();
  for (let offset = 0; offset < notices.length; offset += 100) {
    const batch = notices.slice(offset, offset + 100);
    let results: PushOutcome[] = batch.map(() => "failed");
    try {
      const response = await transport(EXPO_SEND, {
        // Long enough that an accepted batch is rarely counted as failed and sent again.
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify(batch.map(notice => ({ to: notice.device.token, title: notice.title.slice(0, 120), body: notice.body.slice(0, 240),
          data: { ...notice.data, profileId: notice.device.profileId } satisfies MobilePushPayload, sound: "default", priority: "high" }))),
      });
      const result = await response.json().catch(() => null) as { data?: { status?: string; details?: { error?: string } }[] } | null;
      if (response.ok && Array.isArray(result?.data) && result.data.length === batch.length) {
        results = result.data.map(ticket => ticket?.status === "ok" ? "sent" : ticket?.details?.error === "DeviceNotRegistered" ? "gone" : "failed");
        const gone = batch.filter((_, index) => results[index] === "gone").map(notice => notice.device.id);
        if (gone.length) await admin.from(TABLE).delete().in("id", gone).abortSignal(AbortSignal.timeout(READ_MS));
      }
    } catch { /* The whole batch counts as failed. */ }
    outcomes.push(...results);
  }
  return outcomes;
}

export type MobilePushMessage = {
  organizationId: string; profileIds: readonly string[]; type: MobilePushType;
  title: string; body: string; data: MobilePushData;
  /** Identifies the event; each recipient gets it once. */
  dedupeKey: string;
};

/** Best effort: never throws. Callers in a request use queueMobilePush. A passing
 * failure of the push service is retried once; a person whose phones all failed is
 * released, so a repeated attempt of the same event can still reach them. */
export async function sendMobilePush(admin: Admin, message: MobilePushMessage, transport: PushTransport = fetch, retryAfterMs = 1_500): Promise<PushTotals> {
  const totals: PushTotals = { sent: 0, skipped: 0, failed: 0 };
  if (!mobilePushEnabled() || !message.profileIds.length) return totals;
  try {
    const recipients = await pushRecipients(admin, message.organizationId, message.type, message.profileIds);
    if (!recipients.size) return totals;
    const claims = [...recipients.keys()].map(profileId => ({ profileId, key: message.dedupeKey + ":" + profileId, type: message.type, title: message.title, body: message.body }));
    const fresh = await claimPushes(admin, message.organizationId, claims);
    const items = claims.flatMap(claim => {
      const devices = recipients.get(claim.profileId) ?? [];
      if (!fresh.has(claim.key)) { totals.skipped += devices.length; return []; }
      return devices.map(device => ({ claim, notice: { device, title: message.title, body: message.body, data: message.data } }));
    });
    const outcomes = await deliverPushNotices(admin, items.map(item => item.notice), transport);
    const retry = items.map((_, index) => index).filter(index => outcomes[index] === "failed");
    if (retry.length) {
      await new Promise(resolve => setTimeout(resolve, retryAfterMs));
      const again = await deliverPushNotices(admin, retry.map(index => items[index].notice), transport);
      retry.forEach((index, position) => { outcomes[index] = again[position]; });
    }
    totals.sent = outcomes.filter(outcome => outcome === "sent").length;
    totals.failed = outcomes.filter(outcome => outcome === "failed").length;
    const unreached = claims.filter(claim => fresh.has(claim.key)).filter(claim => {
      const results = outcomes.filter((_, index) => items[index].claim === claim);
      return !results.includes("sent") && results.includes("failed");
    });
    if (unreached.length) await releaseClaims(admin, message.organizationId, unreached.map(claim => claim.key));
  } catch {
    totals.failed += 1;
  }
  if (totals.failed) console.warn(JSON.stringify({ event: "mobile.push", type: message.type, sent: totals.sent, failed: totals.failed }));
  return totals;
}

/** Hourly upkeep: phones silent for 90 days and announcements older than 30 days go. */
export async function pruneMobilePush(admin: Admin, organizationId: string, now = new Date()) {
  const devices = await admin.from(TABLE).delete().eq("organization_id", organizationId).eq("environment", mobileEnvironment())
    .lt("last_seen_at", new Date(now.getTime() - 90 * 86_400_000).toISOString()).select("id").abortSignal(AbortSignal.timeout(READ_MS));
  if (missingTable(devices.error)) return { devices: 0, claims: 0 };
  if (devices.error) throw new Error("push upkeep unavailable");
  const claims = await admin.from("motorist_notifications").delete().eq("organization_id", organizationId).eq("kind", "system").eq("status", "archived")
    .like("dedupe_key", CLAIM + "%").lt("created_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).select("id").abortSignal(AbortSignal.timeout(READ_MS));
  if (claims.error) throw new Error("push upkeep unavailable");
  return { devices: (devices.data ?? []).length, claims: (claims.data ?? []).length };
}

/** Sends after the response, so a slow push service never delays the work that
 * caused it. Outside a request (tests, scripts) nothing is queued. */
export function queueMobilePush(work: () => Promise<unknown>) {
  if (!mobilePushEnabled()) return;
  try {
    after(async () => { try { await work(); } catch { /* Push is best effort. */ } });
  } catch { /* No request lifecycle means no detached work. */ }
}
