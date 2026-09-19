import "server-only";
import type { TelephonyTeamPayload, TelephonyTeamOperator } from "@/lib/telephony/team";
import { loadTelephonyStatsCached, type TelephonyStatsDeps } from "./stats";
import { TALKING_STATES } from "./state/types";

/** Extra data stays on the server; never serialize device/settings rows. */
export async function loadTelephonyTeam(deps: TelephonyStatsDeps): Promise<TelephonyTeamPayload> {
  const { admin, organizationId } = deps;
  const [stats, profiles, devices, mobile, sessions, lines] = await Promise.all([
    loadTelephonyStatsCached(deps),
    admin.from("motorist_profiles").select("id,display_name").eq("organization_id", organizationId).eq("active", true).eq("access_status", "active"),
    admin.from("motorist_operator_devices").select("profile_id,device_seen_at").eq("organization_id", organizationId),
    admin.from("motorist_operator_mobile_devices").select("profile_id,device_seen_at").eq("organization_id", organizationId),
    admin.from("motorist_call_sessions").select("id,answered_by_profile_id,caller_number,line_id,state,metadata").eq("organization_id", organizationId).in("state", [...TALKING_STATES]),
    admin.from("motorist_telephony_lines").select("id,label").eq("organization_id", organizationId),
  ]);
  if (profiles.error || devices.error || mobile.error || sessions.error || lines.error) throw new Error("Team data unavailable");
  const latest = (rows: Array<{ profile_id: string; device_seen_at: string | null }>, id: string) =>
    rows.filter(r => r.profile_id === id && r.device_seen_at).map(r => r.device_seen_at!).sort().at(-1) ?? null;
  const operators = (profiles.data ?? []).map((profile): TelephonyTeamOperator => {
    const status = stats.operators.find(row => row.profileId === profile.id);
    const session = sessions.data?.find(row => row.answered_by_profile_id === profile.id);
    return { profileId: profile.id, name: profile.display_name, status: status?.state ?? "offline",
      statusSince: status?.since ?? null, answeredToday: status?.answeredToday ?? 0,
      talkSecondsToday: status?.talkSecondsToday ?? 0, availableSecondsToday: status?.availableSecondsToday ?? 0,
      pausedSecondsToday: status?.pausedSecondsToday ?? 0,
      lastDeviceContactAt: latest(devices.data ?? [], profile.id), lastMobileContactAt: latest(mobile.data ?? [], profile.id),
      ...(session ? { call: { sessionId: session.id, callerNumber: session.caller_number,
        callerName: null, lineLabel: lines.data?.find(line => line.id === session.line_id)?.label ?? null } } : {}),
    };
  }).sort((a,b) => a.name.localeCompare(b.name,"sk"));
  return { checkedAt: (deps.now?.() ?? new Date()).toISOString(), operators };
}
