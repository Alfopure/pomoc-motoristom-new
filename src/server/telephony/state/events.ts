import { decodeClientState } from "../telnyx/client-state";
import type { TelephonyEvent } from "./types";

/**
 * Telnyx webhook envelope → `TelephonyEvent` (pure).
 *
 * Envelope: `{ data: { record_type: "event", event_type, id, occurred_at,
 * payload }, meta: { attempt, delivered_to } }`. Anything malformed yields
 * `null`; the route answers 400 for those.
 */

export const CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "call.initiated",
  "call.answered",
  "call.bridged",
  "call.hangup",
  "call.gather.ended",
  "call.playback.ended",
  "call.dtmf.received",
  "call.hold",
  "call.unhold",
  "call.refer.started",
  "call.refer.completed",
  "call.refer.failed",
  "conference.created",
  "conference.ended",
  "conference.participant.joined",
  "conference.participant.left",
]);

export type EventClass = "control" | "bookkeeping";

export function classifyEventType(type: string): EventClass {
  return CONTROL_EVENT_TYPES.has(type) ? "control" : "bookkeeping";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseTelnyxEnvelope(envelope: unknown): TelephonyEvent | null {
  const root = asRecord(envelope);
  const data = asRecord(root?.data) ?? (root && typeof root.event_type === "string" ? root : null);
  if (!data) return null;
  const id = str(data.id);
  const type = str(data.event_type);
  if (!id || !type) return null;
  const payload = asRecord(data.payload) ?? {};

  const direction = payload.direction === "incoming" || payload.direction === "outgoing" ? payload.direction : null;
  const rawClientState = str(payload.client_state);
  const customHeaders: Array<{ name: string; value: string }> = [];
  if (Array.isArray(payload.custom_headers)) {
    for (const entry of payload.custom_headers) {
      const header = asRecord(entry);
      const name = str(header?.name);
      const value = str(header?.value);
      if (name && value) customHeaders.push({ name, value });
    }
  }

  return {
    kind: "telnyx",
    id,
    type,
    occurredAt: str(data.occurred_at) ?? str(payload.occurred_at),
    callControlId: str(payload.call_control_id),
    callLegId: str(payload.call_leg_id),
    callSessionId: str(payload.call_session_id),
    connectionId: str(payload.connection_id),
    clientState: decodeClientState(rawClientState),
    rawClientState,
    from: str(payload.from),
    to: str(payload.to),
    direction,
    state: str(payload.state),
    hangupCause: str(payload.hangup_cause),
    hangupSource: str(payload.hangup_source),
    sipHangupCause: str(payload.sip_hangup_cause),
    digits: str(payload.digits) ?? str(payload.digit),
    status: str(payload.status),
    conferenceId: str(payload.conference_id),
    customHeaders,
    payload,
  };
}

/** Builds a synthetic envelope (used by tests and the dev simulator). */
export function buildTelnyxEnvelope(input: {
  id: string;
  type: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
}): { data: Record<string, unknown>; meta: Record<string, unknown> } {
  return {
    data: {
      record_type: "event",
      event_type: input.type,
      id: input.id,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload,
    },
    meta: { attempt: 1, delivered_to: "local" },
  };
}
