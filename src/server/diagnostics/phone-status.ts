import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { resolveAppEnvironment } from '@/lib/app-environment';
import type { DiagnosticPhoneCounts, DiagnosticPhoneStatus } from '@/lib/diagnostics/phone-status';
import { DEVICE_LIVENESS_WINDOW_MS, isDeviceLive, nativeMobilePushReachable } from '@/lib/telephony/device-liveness';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireDefaultMotoristActor } from '@/server/api-auth';
import type { DeviceRow } from '@/server/telephony/state/types';
import { diagnosticErrorResponse } from './service';

export const PHONE_STATUS_LIMIT = 500;
const columns = 'device_session_id,device_seen_at,registration_state,telnyx_credential_id,sip_username,credential_expires_at,environment,metadata';
type StatusDevice = Pick<DeviceRow, 'device_session_id' | 'device_seen_at' | 'registration_state' | 'telnyx_credential_id' | 'sip_username' | 'credential_expires_at' | 'environment' | 'metadata'>;
type SourceResult = { data: StatusDevice[] | null; error: unknown };

function summarize(result: SourceResult, mobile: boolean, now: Date): DiagnosticPhoneCounts {
  const counts: DiagnosticPhoneCounts = { source: result.error || !result.data ? 'unavailable' : 'available', total: 0, ready: 0, pushReachable: 0, error: 0, registering: 0, unregistered: 0, stale: 0, unknown: 0, lastSeenAt: null, truncated: false };
  if (counts.source === 'unavailable') return counts;
  const rows = result.data!.slice(0, PHONE_STATUS_LIMIT);
  counts.truncated = result.data!.length > PHONE_STATUS_LIMIT;
  counts.total = rows.length;
  for (const device of rows) {
    const seen = device.device_seen_at ? Date.parse(device.device_seen_at) : NaN;
    const validSeen = Number.isFinite(seen) && seen <= now.getTime();
    if (validSeen && (!counts.lastSeenAt || seen > Date.parse(counts.lastSeenAt))) counts.lastSeenAt = new Date(seen).toISOString();
    // A push lease is independent of the foreground heartbeat. The existing router
    // helper checks its environment, deployment flags, session and credential expiry.
    if (mobile && nativeMobilePushReachable(device, now)) { counts.pushReachable++; continue; }
    if (!validSeen) { counts.unknown++; continue; }
    if (now.getTime() - seen > DEVICE_LIVENESS_WINDOW_MS) { counts.stale++; continue; }
    if (device.registration_state === 'error') { counts.error++; continue; }
    if (device.registration_state === 'registering') { counts.registering++; continue; }
    if (device.registration_state === 'unregistered') { counts.unregistered++; continue; }
    const expiry = device.credential_expires_at ? Date.parse(device.credential_expires_at) : Infinity;
    if (device.registration_state === 'registered' && device.device_session_id && device.telnyx_credential_id && device.sip_username
      && expiry > now.getTime() && isDeviceLive({ deviceSeenAt: device.device_seen_at, registrationState: device.registration_state }, now)) counts.ready++;
    else counts.unknown++;
  }
  return counts;
}

/** Two scoped reads with one deadline; partial failures remain explicitly visible. */
export async function loadDiagnosticPhoneStatus(admin: SupabaseClient<Database>, organizationId: string, now: () => Date = () => new Date()): Promise<DiagnosticPhoneStatus> {
  const environment = resolveAppEnvironment();
  const telephonyEnvironment = environment === 'production' ? 'production' : 'development';
  const signal = AbortSignal.timeout(1_400);
  const read = async (table: 'motorist_operator_devices' | 'motorist_operator_mobile_devices'): Promise<SourceResult> => {
    try {
      return await admin.from(table).select(columns).eq('organization_id', organizationId).eq('environment', telephonyEnvironment)
        .order('device_seen_at', { ascending: false, nullsFirst: false }).limit(PHONE_STATUS_LIMIT + 1).abortSignal(signal);
    } catch { return { data: null, error: true }; }
  };
  const [browser, mobile] = await Promise.all([read('motorist_operator_devices'), read('motorist_operator_mobile_devices')]);
  // Read the clock after the queries so a concurrent legitimate heartbeat is not future data.
  const observed = now();
  return { checkedAt: observed.toISOString(), environment, heartbeatWindowMs: DEVICE_LIVENESS_WINDOW_MS, browser: summarize(browser, false, observed), mobile: summarize(mobile, true, observed) };
}

export async function readDiagnosticPhoneStatus(): Promise<Response> {
  try {
    const actor = await requireDefaultMotoristActor(['manager', 'admin']);
    if (process.env.DIAGNOSTICS_PANEL_ENABLED === 'false') return Response.json({ error: 'Monitor prevádzky je vypnutý.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    return Response.json(await loadDiagnosticPhoneStatus(createSupabaseAdminClient(), actor.organizationId), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return diagnosticErrorResponse(error); }
}
