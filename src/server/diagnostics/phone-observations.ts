import 'server-only';
import { after } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_PHONE_FAILURE_REASONS, isDiagnosticUuid, parseDiagnosticEvent, type DiagnosticEvent } from '@/lib/diagnostics/types';
import type { MotoristActor } from '@/server/api-auth';

export const PHONE_OBSERVATION_FRESH_MS = 120_000;
export function isFreshPhoneFailure(event: DiagnosticEvent, now: number): boolean {
  const occurred = Date.parse(event.occurredAt);
  return event.type === 'phone_lifecycle' && event.module === 'telephony' && event.outcome === 'failed'
    && DIAGNOSTIC_PHONE_FAILURE_REASONS.some(reason => reason === event.reason)
    && isDiagnosticUuid(event.deviceSessionId) && occurred <= now && occurred >= now - PHONE_OBSERVATION_FRESH_MS;
}

/** Only canonical, durably accepted browser observations may become a signal.
 * The ingest RPC also ACKs duplicate IDs and strips unproven device links, so
 * reporting directly from the submitted body would trust unpersisted evidence.
 */
export function deferAcceptedPhoneFailures(actor: Pick<MotoristActor, 'organizationId' | 'profileId'>, events: DiagnosticEvent[], acceptedIds: string[], environment: string): void {
  if (process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED !== 'true') return;
  const now = Date.now();
  const accepted = new Set(acceptedIds);
  const ids = [...new Set(events.filter(event => accepted.has(event.id) && isFreshPhoneFailure(event, now)).map(event => event.id))].slice(0, DIAGNOSTIC_LIMITS.batchEvents);
  if (!ids.length) return;
  const { organizationId, profileId } = actor;
  try {
    after(async () => {
      try {
        const now = Date.now();
        const { data, error } = await createSupabaseAdminClient().from('motorist_diagnostic_events')
          .select('id,event,device_session_id,received_at')
          .eq('organization_id', organizationId).eq('profile_id', profileId).eq('environment', environment).eq('source', 'browser')
          .in('id', ids).gte('received_at', new Date(now - PHONE_OBSERVATION_FRESH_MS).toISOString()).lte('received_at', new Date(now).toISOString())
          .limit(DIAGNOSTIC_LIMITS.batchEvents).abortSignal(AbortSignal.timeout(1000));
        if (error || !data) return;
        const { captureServerError } = await import('./server-errors');
        for (const row of data) {
          const event = parseDiagnosticEvent(row.event);
          const received = Date.parse(row.received_at);
          if (!event || row.id !== event.id || !ids.includes(row.id) || row.device_session_id !== event.deviceSessionId
            || !isFreshPhoneFailure(event, Date.now()) || !Number.isFinite(received) || received > now || received < now - PHONE_OBSERVATION_FRESH_MS) continue;
          const failure = Object.assign(new Error('browser_phone_failure'), { name: 'PhoneLifecycleObservation', code: 'browser_phone_failure' });
          await captureServerError(failure, { source: 'phone_observation', route: 'diagnostics.phone-observation',
            observationEventId: event.id, deviceSessionId: event.deviceSessionId, phoneFailure: event.phoneFailure, phoneReason: event.reason,
            sdkCode: event.sdkCode, rtcEdge: event.rtcEdge, browserBuild: event.buildId });
        }
      } catch { /* Optional reporting never changes the durable batch acknowledgement. */ }
    });
  } catch { /* No retained request lifecycle; do not create detached work. */ }
}
