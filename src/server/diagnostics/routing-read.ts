import 'server-only';
import type { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { RoutingDiagnostic, RoutingDiagnosticMember } from '@/lib/diagnostics/routing';
import { isDiagnosticUuid } from '@/lib/diagnostics/types';

export const ROUTING_READ_LIMITS = { rows: 100, snapshots: 64, bytes: 128 * 1024, members: 64 } as const;
export type RoutingTimelineEvidence = { routing: RoutingDiagnostic[]; routingTruncated: boolean; routingUnavailable: boolean; routingProfiles?: Record<string, string> };
const unavailable = (): RoutingTimelineEvidence => ({ routing: [], routingTruncated: false, routingUnavailable: true });
const reasons = ['all_offers_finished', 'ordered_exhausted', 'no_eligible_members', 'external_number', 'waiting_room', 'hangup_message', 'callback_offer', 'callback_prompt', 'hangup'] as const;
const memberReasons = ['no_presence', 'offline', 'paused', 'ringing', 'on_call', 'wrap_up', 'no_device', 'device_stale', 'open_offer', 'attempted', 'duplicate', 'capacity', 'fanout', 'feature_disabled'] as const;
const presence = ['available', 'ringing', 'on_call', 'after_call_work', 'paused', 'offline'] as const;
const registration = ['registered', 'unregistered', 'registering', 'error', 'unknown'] as const;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);
const nullableEnum = (value: unknown, values: readonly string[]) => value === null || oneOf(value, values);
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Project a closed safe envelope; never return arbitrary stored audit fields. */
export function parseRoutingDiagnostic(value: unknown): RoutingDiagnostic | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || !date(raw.at) || !oneOf(raw.kind, ['selection', 'completed', 'fallback']) || !nullableEnum(raw.strategy, ['all', 'ordered']) || !nullableEnum(raw.reason, reasons)) return null;
  if (raw.step !== null && !integer(raw.step, 10_000)) return null;
  if (raw.ringSecs !== null && !integer(raw.ringSecs, 86_400)) return null;
  if (raw.startedAt !== null && !date(raw.startedAt) || raw.deadlineAt !== null && !date(raw.deadlineAt)) return null;
  for (const field of ['selectedCount', 'skippedCount', 'omittedMembers', 'activeLegCount', 'maxConcurrentLegs', 'maxFanout']) if (!integer(raw[field], 1_000_000)) return null;
  if (!Array.isArray(raw.members) || raw.members.length > ROUTING_READ_LIMITS.members) return null;
  const members: RoutingDiagnosticMember[] = [];
  for (const value of raw.members) {
    const member = record(value);
    if (!member || member.memberId !== null && !isDiagnosticUuid(member.memberId) || member.profileId !== null && !isDiagnosticUuid(member.profileId)) return null;
    if (!oneOf(member.endpoint, ['sip', 'pstn']) || !oneOf(member.outcome, ['selected', 'skipped']) || !nullableEnum(member.reason, memberReasons) || !nullableEnum(member.presence, presence) || !nullableEnum(member.registration, registration) || typeof member.openOffer !== 'boolean') return null;
    if (member.heartbeatAgeMs !== null && !integer(member.heartbeatAgeMs)) return null;
    members.push({ memberId: member.memberId as string | null, profileId: member.profileId as string | null, endpoint: member.endpoint, ...(oneOf(member.applicationDevice, ['web', 'mobile']) ? { applicationDevice: member.applicationDevice } : {}), outcome: member.outcome, reason: member.reason as string | null, presence: member.presence as string | null, registration: member.registration as string | null, heartbeatAgeMs: member.heartbeatAgeMs as number | null, openOffer: member.openOffer });
  }
  return { version: 1, at: raw.at, kind: raw.kind, step: raw.step as number | null, strategy: raw.strategy as RoutingDiagnostic['strategy'], ringSecs: raw.ringSecs as number | null, startedAt: raw.startedAt as string | null, deadlineAt: raw.deadlineAt as string | null, reason: raw.reason as string | null, selectedCount: raw.selectedCount as number, skippedCount: raw.skippedCount as number, omittedMembers: raw.omittedMembers as number, activeLegCount: raw.activeLegCount as number, maxConcurrentLegs: raw.maxConcurrentLegs as number, maxFanout: raw.maxFanout as number, members };
}

/** Called only after the diagnostics RPC authorizes the exact session and actor. */
export async function readRoutingDiagnostics(admin: ReturnType<typeof createSupabaseAdminClient>, query: { organizationId: string; callSessionId: string; since: string; until: string; budgetMs: number }): Promise<RoutingTimelineEvidence> {
  if (!isDiagnosticUuid(query.organizationId) || !isDiagnosticUuid(query.callSessionId) || query.budgetMs < 1) return unavailable();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let collected = unavailable();
  const read = async (): Promise<RoutingTimelineEvidence> => {
    // call_id has an existing index. Also require the exact normalized session:
    // copied or malformed rows must never cross this call's boundary.
    const call = await admin.from('motorist_calls').select('id').eq('organization_id', query.organizationId).eq('session_id', query.callSessionId).abortSignal(controller.signal).maybeSingle();
    if (call.error || !call.data || !isDiagnosticUuid(call.data.id)) return unavailable();
    const result = await admin.from('motorist_call_events').select('routing:normalized_payload->routing')
      .eq('organization_id', query.organizationId).eq('call_id', call.data.id)
      .eq('normalized_payload->>session_id', query.callSessionId)
      .gte('received_at', query.since).lte('received_at', query.until)
      .not('normalized_payload->routing', 'is', null)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .limit(ROUTING_READ_LIMITS.rows + 1).abortSignal(controller.signal);
    if (result.error || !Array.isArray(result.data)) return unavailable();
    const routing: RoutingDiagnostic[] = [];
    let routingTruncated = result.data.length > ROUTING_READ_LIMITS.rows;
    let bytes = 2;
    snapshots: for (const row of result.data.slice(0, ROUTING_READ_LIMITS.rows)) {
      const candidates = record(row)?.routing;
      if (!Array.isArray(candidates)) { routingTruncated = true; continue; }
      if (candidates.length > 32) routingTruncated = true;
      for (const candidate of candidates.slice(0, 32)) {
        const parsed = parseRoutingDiagnostic(candidate);
        if (!parsed) { routingTruncated = true; continue; }
        const size = new TextEncoder().encode(JSON.stringify(parsed)).byteLength + 1;
        if (routing.length >= ROUTING_READ_LIMITS.snapshots || bytes + size > ROUTING_READ_LIMITS.bytes) { routingTruncated = true; break snapshots; }
        bytes += size;
        routing.push(parsed);
        if (parsed.omittedMembers > 0) routingTruncated = true;
      }
    }
    collected = { routing, routingTruncated, routingUnavailable: false };
    const profileIds = [...new Set(routing.flatMap(snapshot => snapshot.members.map(member => member.profileId).filter((id): id is string => id !== null)))].slice(0, 128);
    if (!profileIds.length) return collected;
    // Names are fetched separately, from this organization only. They are never
    // written into the durable call audit or used as proof of device activity.
    const profiles = await admin.from('motorist_profiles').select('id,display_name').eq('organization_id', query.organizationId).in('id', profileIds).limit(128).abortSignal(controller.signal);
    if (profiles.error || !Array.isArray(profiles.data)) return collected;
    const routingProfiles: Record<string, string> = {};
    for (const profile of profiles.data) {
      if (profileIds.includes(profile.id) && typeof profile.display_name === 'string' && profile.display_name.trim() && profile.display_name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(profile.display_name)) routingProfiles[profile.id] = profile.display_name;
    }
    return { ...collected, routingProfiles };
  };
  try {
    // Leave time for the existing timeline response even if this optional read stalls.
    return await Promise.race([read().catch(() => collected), new Promise<RoutingTimelineEvidence>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(collected); }, Math.min(query.budgetMs, 500));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
