import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nativeVoiceEnabled, resolveAppEnvironment } from "@/lib/app-environment";
import type { MobileVoiceColleague, MobileVoiceColleagues } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { colleaguePresenceBlock } from "@/lib/telephony/colleague-call";
import { nativeMobilePushReachable } from "@/lib/telephony/device-liveness";
import { effectivePresenceStatus } from "@/lib/telephony/presence-policy";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MOBILE_ROLES } from "@/server/mobile/auth";
import { MutationError } from "@/server/mutation-error";
import { deviceIsLive, deviceSipUri } from "@/server/telephony/operator-devices";
import { telephonyStabilityEnabled } from "@/server/telephony/stability";

type Admin = SupabaseClient<Database>;
const unavailable = () => new MutationError("Kolegov sa nepodarilo overiť.", 503);
/** Names are presentation only and never inherit a SIP/phone fallback. */
export function mobileColleagueName(value: unknown): string {
  if (typeof value !== "string") return "Kolega";
  const clean = [...value].filter(character => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("").trim();
  const shortened = clean.slice(0, 120);
  const last = shortened.charCodeAt(shortened.length - 1);
  const label = last >= 0xd800 && last <= 0xdbff ? shortened.slice(0, -1) : shortened;
  return label.trim() || "Kolega";
}

function profiles(admin: Admin, actor: MotoristActor) {
  return admin.from("motorist_profiles").select("id, display_name")
    .eq("organization_id", actor.organizationId).eq("active", true).eq("access_status", "active")
    .eq("kind", "human").in("role", [...MOBILE_ROLES]).neq("id", actor.profileId);
}

export function readColleagueQuery(params: URLSearchParams): string {
  if ([...params.keys()].some(key => key !== "q") || params.getAll("q").length > 1) throw new MutationError("Neplatné vyhľadávanie kolegov.", 400);
  const q = (params.get("q") ?? "").trim();
  // PostgREST treats asterisk as a LIKE alias even inside an escaped pattern.
  if (q.includes("*")) throw new MutationError("Vyhľadávanie nepodporuje hviezdičku. Zadajte inú časť mena.", 400);
  if (q.length > 80) throw new MutationError("Vyhľadávanie môže mať najviac 80 znakov.", 400);
  return q;
}

export async function requireMobileColleague(admin: Admin, actor: MotoristActor, profileId: string) {
  if (!isUuid(profileId)) throw new MutationError("Kolega sa nenašiel.", 400);
  const result = await profiles(admin, actor).eq("id", profileId).maybeSingle();
  if (result.error) throw unavailable();
  if (!result.data) throw new MutationError("Kolega sa nenašiel.", 404);
  return result.data;
}

/** Observed hints only; callColleague revalidates presence, endpoints and capacity. */
export async function getMobileVoiceColleagues(
  actor: MotoristActor, q: string, admin: Admin = createSupabaseAdminClient(), now = new Date(),
): Promise<Pick<MobileVoiceColleagues, "colleagues" | "hasMore">> {
  let query = profiles(admin, actor).order("display_name").order("id").limit(51);
  if (q) query = query.ilike("display_name", "%" + q.replace(/[\\%_]/g, "\\$&") + "%");
  const result = await query;
  if (result.error || !result.data) throw unavailable();
  const selected = result.data.slice(0, 50), ids = selected.map(profile => profile.id);
  if (!ids.length) return { colleagues: [], hasMore: false };
  const environment = resolveAppEnvironment() === "production" ? "production" : "development";
  const [presence, web, mobile, settings] = await Promise.all([
    admin.from("motorist_operator_presence").select("*").eq("organization_id", actor.organizationId).in("profile_id", ids),
    admin.from("motorist_operator_devices").select("*").eq("organization_id", actor.organizationId).eq("environment", environment).in("profile_id", ids),
    nativeVoiceEnabled()
      ? admin.from("motorist_operator_mobile_devices").select("*").eq("organization_id", actor.organizationId).eq("environment", environment).in("profile_id", ids)
      : Promise.resolve({ data: [], error: null }),
    telephonyStabilityEnabled()
      ? admin.from("motorist_operator_telephony_settings").select("profile_id, delivery_mode").eq("organization_id", actor.organizationId).in("profile_id", ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if ([presence, web, mobile, settings].some(read => read.error || !read.data)) throw unavailable();
  const colleagues = selected.map(profile => {
    const row = presence.data?.find(item => item.profile_id === profile.id);
    const effective = row ? effectivePresenceStatus(row, now) : "offline";
    let reason: MobileVoiceColleague["reason"] = colleaguePresenceBlock({ status: effective, inCall: Boolean(row?.current_session_id) });
    if (!reason && settings.data?.find(item => item.profile_id === profile.id)?.delivery_mode === "personal_mobile") reason = "personal_mobile";
    const webDevice = web.data?.find(item => item.profile_id === profile.id);
    const mobileDevice = mobile.data?.find(item => item.profile_id === profile.id);
    const reachable = Boolean(webDevice && deviceIsLive(webDevice, now) && deviceSipUri(webDevice)
      || mobileDevice && (deviceIsLive(mobileDevice, now) || nativeMobilePushReachable(mobileDevice, now)) && deviceSipUri(mobileDevice));
    if (!reason && !reachable) reason = "no_phone";
    const status: MobileVoiceColleague["status"] = reason === "busy" || reason === "wrap_up" ? "busy"
      : effective === "available" || effective === "paused" ? effective : "offline";
    return { profileId: profile.id, displayName: mobileColleagueName(profile.display_name), status, canCall: reason === null, reason };
  });
  return { colleagues, hasMore: result.data.length > 50 };
}
