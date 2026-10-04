import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { TelephonyAlert } from "./alerts";

const MAX_CALLS = 20;
const MAX_EVENTS = 20;
const MAX_LEGS = 200;
type Session = Database["public"]["Tables"]["motorist_call_sessions"]["Row"];
type Leg = Database["public"]["Tables"]["motorist_call_legs"]["Row"];

export type AlertCallEvidence = {
  sessionId: string;
  checks: string[];
  state: string;
  direction: string;
  caller: string | null;
  called: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  confirmedAt: string | null;
  confirmationSource: "conference_membership" | "bridge_events" | null;
  pendingConnection: boolean;
  legs: Array<{ id: string; role: string; state: string; answeredAt: string | null; bridgedAt: string | null; endedAt: string | null; hangupCause: string | null }>;
};

export type TelephonyAlertEvidence = {
  calls: AlertCallEvidence[];
  events: Array<{ eventId: string; type: string; receivedAt: string | null; sessionIds: string[] }>;
  requestedSessionIds: string[];
  missingSessionIds: string[];
  errors: string[];
  truncated: boolean;
};

export const emptyAlertEvidence = (): TelephonyAlertEvidence => ({ calls: [], events: [], requestedSessionIds: [], missingSessionIds: [], errors: [], truncated: false });

export function alertObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && /^[a-zA-Z0-9:_.-]{1,128}$/.test(entry)) : [];
}

function providerIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 2048) : [];
}

export function alertSessionIds(alert: TelephonyAlert): string[] {
  return [...new Set([
    ...ids(alert.detail.sessionIds), ...ids(alert.detail.stuckIds),
    ...ids([alert.detail.sessionId]),
    ...ids(Array.isArray(alert.detail.entries) ? alert.detail.entries.map((entry) => alertObject(entry).sessionId) : []),
  ])];
}

function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function maskedNumber(value: unknown): string | null {
  return typeof value === "string" && /\d{4}/.test(value) ? `•••${value.replace(/\D/g, "").slice(-4)}` : null;
}

/** Only selected facts leave the database; metadata, provider credentials and raw envelopes never enter the e-mail. */
function projectCall(session: Session, legs: Leg[], checks: string[]): AlertCallEvidence {
  const recording = alertObject(alertObject(session.metadata).recording);
  const connection = alertObject(recording.connection);
  const conferenceAt = iso(connection.confirmedAt);
  const customerAt = legs.filter((leg) => leg.role === "customer").map((leg) => iso(leg.bridged_at)).find(Boolean);
  const operatorAt = legs.filter((leg) => ["operator", "external"].includes(leg.role)).map((leg) => iso(leg.bridged_at)).find(Boolean);
  const bridgeAt = customerAt && operatorAt ? (Date.parse(customerAt) > Date.parse(operatorAt) ? customerAt : operatorAt) : null;
  const pending = alertObject(recording.pendingAudio).commands;
  return {
    sessionId: session.id, checks, state: session.state, direction: session.direction,
    caller: maskedNumber(session.caller_number), called: maskedNumber(session.called_number),
    startedAt: iso(session.started_at), answeredAt: iso(session.answered_at), endedAt: iso(session.ended_at),
    confirmedAt: conferenceAt ?? bridgeAt,
    confirmationSource: conferenceAt ? "conference_membership" : bridgeAt ? "bridge_events" : null,
    pendingConnection: Array.isArray(pending) && pending.length > 0 || Object.keys(connection).length > 0 && !conferenceAt,
    legs: legs.map((leg) => ({ id: leg.id, role: leg.role, state: leg.state, answeredAt: iso(leg.answered_at),
      bridgedAt: iso(leg.bridged_at), endedAt: iso(leg.ended_at), hangupCause: leg.hangup_cause })),
  };
}

/** Bounded, read-only and best effort. A missing diagnostic must never prevent the original alert being sent. */
export async function loadTelephonyAlertEvidence(deps: { admin: SupabaseClient<Database>; organizationId: string; alerts: TelephonyAlert[] }): Promise<TelephonyAlertEvidence> {
  const evidence = emptyAlertEvidence();
  const checksById = new Map<string, Set<string>>();
  const add = (id: string, check: string) => checksById.set(id, new Set([...(checksById.get(id) ?? []), check]));
  for (const alert of deps.alerts) for (const id of alertSessionIds(alert)) add(id, alert.check);
  try {
    const allEventIds = [...new Set(deps.alerts.filter((alert) => alert.check === "ledger").flatMap((alert) => ids(alert.detail.failedIds)))];
    evidence.truncated = allEventIds.length > MAX_EVENTS;
    if (allEventIds.length) {
      const events = await deps.admin.from("motorist_telnyx_webhook_events")
        .select("event_id, event_type, received_at, call_control_id, call_session_id")
        .eq("organization_id", deps.organizationId).in("event_id", allEventIds.slice(0, MAX_EVENTS)).limit(MAX_EVENTS);
      if (events.error) evidence.errors.push(`ledger_lookup: ${events.error.message}`);
      else {
        const controls = providerIds((events.data ?? []).map((event) => event.call_control_id));
        const providerSessions = providerIds((events.data ?? []).map((event) => event.call_session_id));
        if ((events.data?.length ?? 0) < Math.min(allEventIds.length, MAX_EVENTS)) evidence.errors.push("ledger_events_missing");
        // Telnyx call_session_id is a provider ID, not motorist_call_sessions.id.
        const [legs, sessions] = await Promise.all([
          controls.length ? deps.admin.from("motorist_call_legs").select("session_id, telnyx_call_control_id")
            .eq("organization_id", deps.organizationId).in("telnyx_call_control_id", controls).limit(MAX_EVENTS + 1) : Promise.resolve({ data: [], error: null }),
          providerSessions.length ? deps.admin.from("motorist_call_sessions").select("id, telnyx_session_id")
            .eq("organization_id", deps.organizationId).in("telnyx_session_id", providerSessions).limit(MAX_EVENTS + 1) : Promise.resolve({ data: [], error: null }),
        ]);
        for (const result of [legs, sessions]) {
          if (result.error) evidence.errors.push(`ledger_correlation: ${result.error.message}`);
          if ((result.data?.length ?? 0) > MAX_EVENTS) evidence.truncated = true;
        }
        for (const event of events.data ?? []) {
          const sessionIds = [...new Set([
            ...(legs.data ?? []).filter((leg) => leg.telnyx_call_control_id === event.call_control_id).map((leg) => leg.session_id),
            ...(sessions.data ?? []).filter((session) => session.telnyx_session_id === event.call_session_id).map((session) => session.id),
          ])];
          for (const id of sessionIds) add(id, "ledger");
          if (!sessionIds.length) evidence.errors.push(`ledger_session_unknown: ${event.event_id}`);
          evidence.events.push({ eventId: event.event_id, type: event.event_type, receivedAt: iso(event.received_at), sessionIds });
        }
      }
    }
    const requested = [...checksById.keys()];
    evidence.truncated ||= requested.length > MAX_CALLS;
    evidence.requestedSessionIds = requested.slice(0, MAX_CALLS);
    if (!evidence.requestedSessionIds.length) return evidence;
    const [sessions, legs] = await Promise.all([
      deps.admin.from("motorist_call_sessions")
        .select("id, state, direction, caller_number, called_number, started_at, answered_at, ended_at, metadata")
        .eq("organization_id", deps.organizationId).in("id", evidence.requestedSessionIds).limit(MAX_CALLS),
      deps.admin.from("motorist_call_legs")
        .select("id, session_id, role, state, answered_at, bridged_at, ended_at, hangup_cause")
        .eq("organization_id", deps.organizationId).in("session_id", evidence.requestedSessionIds).limit(MAX_LEGS + 1),
    ]);
    if (sessions.error) evidence.errors.push(`sessions_lookup: ${sessions.error.message}`);
    if (legs.error) evidence.errors.push(`legs_lookup: ${legs.error.message}`);
    evidence.truncated ||= (legs.data?.length ?? 0) > MAX_LEGS;
    evidence.calls = (sessions.data ?? []).map((session) => projectCall(session as Session,
      (legs.data ?? []).slice(0, MAX_LEGS).filter((leg) => leg.session_id === session.id) as Leg[], [...(checksById.get(session.id) ?? [])]));
  } catch {
    evidence.errors.push("evidence_lookup_failed");
  }
  evidence.missingSessionIds = evidence.requestedSessionIds.filter((id) => !evidence.calls.some((call) => call.sessionId === id));
  return evidence;
}
