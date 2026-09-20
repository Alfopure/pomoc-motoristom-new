import "server-only";
import type { TelephonyTeamPayload, TelephonyTeamOperator } from "@/lib/telephony/team";
import { loadTelephonyStatsCached, type TelephonyStatsDeps } from "./stats";
import { deviceIsLive } from "./operator-devices";
import { deviceLastOnlineAt } from "./device-online";
import { telephonyEnvironment } from "./runtime";
import { TALKING_STATES, type DeviceRow, type TelephonyEnvironment } from "./state/types";

/** Extra data stays on the server; never serialize device/settings rows. */
export async function loadTelephonyTeam(deps: TelephonyStatsDeps & { environment?: TelephonyEnvironment }): Promise<TelephonyTeamPayload> {
  const { admin, organizationId } = deps;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const environment = deps.environment ?? telephonyEnvironment();
  const [stats, profiles, devices, mobile, sessions, lines] = await Promise.all([
    loadTelephonyStatsCached(deps),
    admin.from("motorist_profiles").select("id,display_name").eq("organization_id", organizationId).eq("active", true).eq("access_status", "active"),
    admin.from("motorist_operator_devices").select("profile_id,device_seen_at,registration_state,metadata").eq("organization_id", organizationId).eq("environment", environment),
    admin.from("motorist_operator_mobile_devices").select("profile_id,device_seen_at,registration_state,metadata").eq("organization_id", organizationId).eq("environment", environment),
    admin.from("motorist_call_sessions").select("id,answered_by_profile_id,caller_number,line_id,state,metadata").eq("organization_id", organizationId).in("state", [...TALKING_STATES]),
    admin.from("motorist_telephony_lines").select("id,label").eq("organization_id", organizationId),
  ]);
  if (profiles.error || devices.error || mobile.error || sessions.error || lines.error) throw new Error("Team data unavailable");
  const now = deps.now?.() ?? new Date();
  type ContactRow = Pick<DeviceRow, "profile_id" | "device_seen_at" | "registration_state" | "metadata">;
  const latest = (rows: ContactRow[], id: string) => rows.filter(row => row.profile_id === id)
    .map(row => deviceLastOnlineAt(row, now)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const operators = (profiles.data ?? []).map((profile): TelephonyTeamOperator => {
    const status = stats.operators.find(row => row.profileId === profile.id);
    const session = sessions.data?.find(row => row.answered_by_profile_id === profile.id);
    const lastDeviceContactAt = latest(devices.data ?? [], profile.id);
    const lastMobileContactAt = latest(mobile.data ?? [], profile.id);
    const online = [...(devices.data ?? []), ...(mobile.data ?? [])].some(device => device.profile_id === profile.id &&
      device.registration_state === "registered" && device.device_seen_at !== null && Date.parse(device.device_seen_at) <= now.getTime() &&
      deviceIsLive(device, now));
    return { profileId: profile.id, name: profile.display_name, status: status?.state ?? "offline",
      online, lastOnlineAt: [lastDeviceContactAt, lastMobileContactAt].filter((value): value is string => value !== null).sort().at(-1) ?? null,
      statusSince: status?.since ?? null, answeredToday: status?.answeredToday ?? 0,
      talkSecondsToday: status?.talkSecondsToday ?? 0, availableSecondsToday: status?.availableSecondsToday ?? 0,
      pausedSecondsToday: status?.pausedSecondsToday ?? 0,
      lastDeviceContactAt, lastMobileContactAt,
      ...(session ? { call: { sessionId: session.id, callerNumber: session.caller_number,
        callerName: null, lineLabel: lines.data?.find(line => line.id === session.line_id)?.label ?? null } } : {}),
    };
  }).sort((a,b) => a.name.localeCompare(b.name,"sk"));
  return { checkedAt, operators };
}
