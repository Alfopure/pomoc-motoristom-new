import { createHash } from "node:crypto";
import type { Command, LegRow, ReduceResult, SessionEvent, SessionRow } from "./state/types";
import { readMeta, toJson } from "./state/types";
import type { TelnyxClient } from "./telnyx/client";

export type ContactScope = {
  organizationId: string; caseId: string | null; lineId: string | null;
  customerNumber: string | null; startedAt: string; callbackRequestId: string | null;
};

/** Historical facts only: none of these records authorizes a provider command. */
export type ContactProof = {
  version: 1; id: string; operationId: string; sessionId: string; scope: ContactScope;
  occurredAt: string; customerLegId: string; operatorLegId: string;
  operatorProfileId: string | null; customerControlId: string; operatorControlId: string;
  topology: "bridge" | "conference"; conferenceId: string | null; eventIds: string[];
  conferenceSnapshot?: ConferenceContactSnapshot;
};
type AudibleConferenceParticipant = { id: string; callControlId: string; callLegId: string; status: "joined"; muted: false; onHold: false; whisperCallControlIds: [] };
export type ConferenceContactSnapshot = {
  source: "telnyx_conference_participants_v1"; conferenceId: string; requestedAt: string; observedAt: string;
  participants: [AudibleConferenceParticipant, AudibleConferenceParticipant];
};
type Observation = { eventId: string; at: string; conferenceId: string | null };
export type ContactOperation = {
  id: string; scope: ContactScope; sourceControlId: string; topology: "bridge" | "conference"; startedAt: string; endedAt: string | null;
  customerLegId: string; operatorLegId: string; operatorProfileId: string | null;
  customerControlId: string; operatorControlId: string; conferenceId: string | null;
  conferenceName: string | null; observations: Record<string, Observation>;
  customerProviderLegId?: string | null; operatorProviderLegId?: string | null;
};
type ConferenceObservation = { eventId: string; at: string; conferenceId: string; controlId: string; joined: boolean };
export type ContactHistory = { version: 1; operations: ContactOperation[]; proofs: ContactProof[]; conferenceObservations?: ConferenceObservation[] };
export type ContactSnapshot = { session: SessionRow; legs: LegRow[] };

/** Short enough for the 200-byte Telnyx client_state with an owned leg token. */
export function contactOperationIntent(commandId: string): string {
  return `ct:${createHash("sha256").update(commandId).digest("hex").slice(0, 16)}`;
}

export function readContactHistory(session: Pick<SessionRow, "metadata">): ContactHistory {
  const history = readMeta(session).callback_contact as ContactHistory | undefined;
  return history?.version === 1 && Array.isArray(history.operations) && Array.isArray(history.proofs)
    ? structuredClone(history) : { version: 1, operations: [], proofs: [] };
}

function servesCustomer(state: ContactSnapshot, leg: LegRow): boolean {
  return ["operator", "external"].includes(leg.role) && Boolean(leg.profile_id) && leg.profile_id === state.session.answered_by_profile_id
    || leg.role === "external" && !leg.profile_id && leg.to_number === readMeta(state.session).answered_external;
}

/** Save under the session lease BEFORE executing commands, independently of recording policy. */
export function collectContactOperation(state: ContactSnapshot, commands: Command[], event: SessionEvent): ContactHistory {
  const history = readContactHistory(state.session);
  const at = event.occurredAt;
  if (!at || !Number.isFinite(Date.parse(at))) return history;
  const customer = state.legs.find((leg) => leg.role === "customer" && !leg.ended_at);
  const meta = readMeta(state.session);
  const answeredControlId = typeof meta.answered_leg_call_control_id === "string" ? meta.answered_leg_call_control_id
    : state.session.answered_by_profile_id ? meta.accepted_device_legs?.[state.session.answered_by_profile_id] : undefined;
  const serving = state.legs.filter(leg => !leg.ended_at && leg.answered_at && servesCustomer(state, leg));
  // A prior ring/old device leg can still await its hangup webhook. Bind the
  // actual accepted serving leg, never the first row with the same profile.
  const operator = answeredControlId ? serving.find(leg => leg.telnyx_call_control_id === answeredControlId)
    : serving.length === 1 ? serving[0] : undefined;
  for (const command of commands) {
    if (command.kind === "ring_fanout") continue;
    const affected = "leg" in command ? command.leg.callControlId : "legs" in command
      ? command.legs.find(leg => leg.callControlId === customer?.telnyx_call_control_id || leg.callControlId === operator?.telnyx_call_control_id)?.callControlId ?? null : null;
    const conferenceId = command.conferenceId ?? state.session.conference_id;
    const closes = ["bridge", "conference_create", "conference_join", "hangup", "transfer", "conference_leave", "conference_hold", "conference_mute"].includes(command.kind);
    if (closes) {
      const ids = command.kind === "bridge" ? [command.leg.callControlId, command.target.callControlId] : "legs" in command ? command.legs.map((leg) => leg.callControlId) : [affected];
      for (const operation of history.operations) {
        if (operation.id === command.commandId) continue;
        if (command.kind === "conference_join" && operation.topology === "conference" && operation.conferenceId === state.session.conference_id) continue;
        if (!operation.endedAt && ids.some((id) => id === operation.customerControlId || id === operation.operatorControlId)) operation.endedAt = at;
      }
    }
    if (!customer || !operator || history.operations.some((operation) => operation.id === command.commandId)) continue;
    if (command.kind === "bridge") {
      if (command.playRingtone) continue;
      const ids = [command.leg.callControlId, command.target.callControlId];
      if (!ids.includes(customer.telnyx_call_control_id) || !ids.includes(operator.telnyx_call_control_id)) continue;
    } else if (["conference_create", "conference_join", "conference_unhold", "conference_unmute"].includes(command.kind)) {
      if (command.kind === "conference_join" && command.supervisorRole) continue;
      if ((command.kind === "conference_unhold" || command.kind === "conference_unmute") && !conferenceId) continue;
      if (affected !== customer.telnyx_call_control_id && affected !== operator.telnyx_call_control_id) continue;
      // The create record follows the conference through subsequent normal joins.
      if (history.operations.some((operation) => !operation.endedAt && operation.topology === "conference"
        && operation.customerLegId === customer.id && operation.operatorLegId === operator.id
        && (operation.conferenceId === conferenceId || operation.conferenceId === null))) continue;
    } else continue;
    for (const operation of history.operations) if (!operation.endedAt) operation.endedAt = at;
    const callbackRequestId = readMeta(state.session).callbackRequestId;
    const scope: ContactScope = {
      organizationId: state.session.organization_id, caseId: state.session.case_id, lineId: state.session.line_id,
      customerNumber: state.session.direction === "outbound" ? state.session.called_number : state.session.caller_number,
      startedAt: state.session.started_at, callbackRequestId: typeof callbackRequestId === "string" ? callbackRequestId : null,
    };
    history.operations.push({ id: command.commandId, scope, sourceControlId: affected!, topology: command.kind === "bridge" && !command.recordingConferenceName ? "bridge" : "conference", startedAt: at, endedAt: null,
      customerLegId: customer.id, operatorLegId: operator.id, operatorProfileId: operator.profile_id,
      customerControlId: customer.telnyx_call_control_id, operatorControlId: operator.telnyx_call_control_id,
      customerProviderLegId: customer.telnyx_call_leg_id, operatorProviderLegId: operator.telnyx_call_leg_id,
      conferenceId: command.kind === "conference_create" || command.kind === "bridge" && command.recordingConferenceName ? null : conferenceId,
      conferenceName: command.kind === "conference_create" ? command.name : command.kind === "bridge" ? command.recordingConferenceName ?? null : null, observations: {} });
  }
  return history;
}

/** Shared preparation for ordinary, rejected, continuation and compensation
 * branches. Freeze the prospective serving pair before any provider command. */
export function attachContactOperations(snapshot: ContactSnapshot, result: ReduceResult, event: SessionEvent, durable: boolean): void {
  if (result.ignored || !durable && !readContactHistory(snapshot.session).operations.length) return;
  for (const branch of [result, ...(result.guard ? [result.guard.onRejected] : [])]) {
    const after = { ...snapshot.session, ...branch.next.session };
    // A compensation was built before the provider operation ran. Its saved
    // metadata must not replace proof/history captured since that point.
    after.metadata = toJson({ ...readMeta(after), callback_contact: readContactHistory(snapshot.session) });
    const legs = snapshot.legs.map(leg => ({ ...leg, ...branch.next.legs.find(patch => patch.callControlId === leg.telnyx_call_control_id)?.values }));
    const history = collectContactOperation({ session: after, legs }, branch.commands, event);
    branch.next.session.metadata = toJson({ ...readMeta(after), callback_contact: history });
    branch.next.contactProofs = history.proofs.map(toJson);
  }
}

export function bindContactConference(history: ContactHistory, commandId: string, conferenceId: string): ContactHistory {
  const copy = structuredClone(history);
  for (const operation of copy.operations) if (operation.id === commandId && operation.topology === "conference" && !operation.conferenceId) operation.conferenceId = conferenceId;
  return copy;
}

function validAt(leg: LegRow | undefined, at: string): boolean {
  const time = Date.parse(at);
  return Boolean(leg && Number.isFinite(time) && Date.parse(leg.initiated_at ?? leg.created_at) <= time
    && (!leg.ended_at || time <= Date.parse(leg.ended_at)));
}

function appendContactProof(state: ContactSnapshot, history: ContactHistory, operation: ContactOperation): void {
  // Separate membership events are candidates only: an intermediate leave may
  // still be undelivered. Conference proof requires a single provider snapshot.
  if (operation.topology === "conference") return;
  const a = operation.observations[operation.customerControlId], b = operation.observations[operation.operatorControlId];
  if (!a || !b || history.proofs.some(proof => proof.operationId === operation.id)) return;
  const occurredAt = Date.parse(a.at) > Date.parse(b.at) ? a.at : b.at;
  const customer = state.legs.find(leg => leg.id === operation.customerLegId && leg.telnyx_call_control_id === operation.customerControlId);
  const operator = state.legs.find(leg => leg.id === operation.operatorLegId && leg.telnyx_call_control_id === operation.operatorControlId);
  if (!validAt(customer, occurredAt) || !validAt(operator, occurredAt)) return;
  history.proofs.push({ version: 1, id: `contact:${operation.id}`, operationId: operation.id, sessionId: state.session.id, scope: operation.scope, occurredAt,
    customerLegId: operation.customerLegId, operatorLegId: operation.operatorLegId, operatorProfileId: operation.operatorProfileId,
    customerControlId: operation.customerControlId, operatorControlId: operation.operatorControlId,
    topology: operation.topology, conferenceId: operation.conferenceId, eventIds: [a.eventId, b.eventId] });
}

/** Also run for ignored/terminal and duplicate events. Event-time identities survive transfer/hangup. */
export function collectContactProof(state: ContactSnapshot, event: SessionEvent): ContactHistory {
  const history = readContactHistory(state.session);
  if (event.kind !== "telnyx" || !event.occurredAt || !Number.isFinite(Date.parse(event.occurredAt))) return history;
  const at = event.occurredAt;
  if (event.type === "conference.ended" && event.conferenceId) {
    const observations = history.conferenceObservations ??= [];
    if (!observations.some(item => item.eventId === event.id)) observations.push({ eventId: event.id, at, conferenceId: event.conferenceId, controlId: "*", joined: false });
  }
  for (const operation of history.operations) {
    if (!operation.scope || operation.scope.organizationId !== state.session.organization_id) continue;
    const customer = state.legs.find((leg) => leg.id === operation.customerLegId && leg.telnyx_call_control_id === operation.customerControlId);
    const operator = state.legs.find((leg) => leg.id === operation.operatorLegId && leg.telnyx_call_control_id === operation.operatorControlId);
    if (operation.topology === "bridge") {
      if (!event.callControlId || event.callControlId !== operation.customerControlId && event.callControlId !== operation.operatorControlId) continue;
      if (Date.parse(at) < Date.parse(operation.startedAt) || operation.endedAt && Date.parse(at) > Date.parse(operation.endedAt)) continue;
      if (!validAt(customer, at) || !validAt(operator, at)) continue;
      if (![operation.customerControlId, operation.operatorControlId].includes(operation.sourceControlId)) continue;
      if (event.type !== "call.bridged") continue;
      const expectedIntent = contactOperationIntent(operation.id);
      if (event.callControlId === operation.sourceControlId
        && (event.clientState?.sid !== state.session.id || event.clientState?.intent !== expectedIntent)) continue;
      if (event.clientState?.intent?.startsWith("ct:") && event.clientState.intent !== expectedIntent) continue;
    }
    if (operation.topology === "conference") {
      if (event.type === "conference.created" && event.conferenceId && event.payload.name === operation.conferenceName &&
        (!event.callControlId || event.callControlId === operation.sourceControlId) && Date.parse(at) >= Date.parse(operation.startedAt)) {
        operation.conferenceId ??= event.conferenceId;
      }
      continue;
    } else if (event.callControlId) operation.observations[event.callControlId] ??= { eventId: event.id, at, conferenceId: event.conferenceId };
    appendContactProof(state, history, operation);
  }
  return history;
}

export type ConferenceContactVerification = { history: ContactHistory; proof: ContactProof | null; retry: boolean; reason: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function audibleParticipant(value: unknown, conferenceId: string, controlId: string, legId: string): AudibleConferenceParticipant | null {
  const row = record(value);
  if (row.record_type !== "participant" || typeof row.id !== "string" || !row.id || row.call_control_id !== controlId ||
    row.call_leg_id !== legId || record(row.conference).id !== conferenceId || row.status !== "joined" ||
    row.muted !== false || row.on_hold !== false || !Array.isArray(row.whisper_call_control_ids) || row.whisper_call_control_ids.length !== 0) return null;
  return { id: row.id, callControlId: controlId, callLegId: legId, status: "joined", muted: false, onHold: false, whisperCallControlIds: [] };
}

/** One bounded provider response must observe the exact audible pair together.
 * Official schema: /openapi/source/external/call-control/call-control.json,
 * Participant status = joining | joined | left; muted/on_hold/whisper IDs are
 * required. Never merge pages or infer missing positive state from join events.
 * Caller persists history + fulfillment obligation under the session lease/CAS,
 * and retains a separate retry obligation when retry=true. This read never
 * issues audio commands, and provider failures are values rather than throws.
 */
export async function verifyConferenceContact(
  deps: { telnyx: Pick<TelnyxClient, "request"> | null; now: () => Date }, state: ContactSnapshot, operationId: string,
): Promise<ConferenceContactVerification> {
  const history = readContactHistory(state.session);
  const result = (reason: string, retry: boolean, proof: ContactProof | null = null): ConferenceContactVerification => ({ history, proof, retry, reason });
  const existing = history.proofs.find(proof => proof.operationId === operationId && proof.conferenceSnapshot?.source === "telnyx_conference_participants_v1");
  if (existing) return result("already_verified", false, existing);
  const operation = history.operations.find(item => item.id === operationId && item.topology === "conference");
  const requestedAt = deps.now().toISOString();
  if (!operation || operation.scope?.organizationId !== state.session.organization_id || operation.endedAt || state.session.ended_at ||
    ["ended", "failed"].includes(state.session.state)) return result("operation_closed", false);
  if (history.conferenceObservations?.some(item => item.conferenceId === operation.conferenceId && item.controlId === "*" && Date.parse(item.at) <= Date.parse(requestedAt))) return result("conference_closed", false);
  const customer = state.legs.find(leg => leg.id === operation.customerLegId && leg.telnyx_call_control_id === operation.customerControlId && leg.role === "customer");
  const operator = state.legs.find(leg => leg.id === operation.operatorLegId && leg.telnyx_call_control_id === operation.operatorControlId && servesCustomer(state, leg));
  if (!customer || !operator || customer.ended_at || operator.ended_at || !validAt(customer, requestedAt) || !validAt(operator, requestedAt) ||
    Date.parse(requestedAt) < Date.parse(operation.startedAt)) return result("pair_unavailable", false);
  const customerLegId = operation.customerProviderLegId ?? customer.telnyx_call_leg_id;
  const operatorLegId = operation.operatorProviderLegId ?? operator.telnyx_call_leg_id;
  if (!operation.conferenceId || !customerLegId || !operatorLegId || !deps.telnyx) return result("identity_unavailable", true);
  if (customerLegId !== customer.telnyx_call_leg_id || operatorLegId !== operator.telnyx_call_leg_id || customerLegId === operatorLegId ||
    operation.customerControlId === operation.operatorControlId) return result("pair_identity_changed", false);
  let response: unknown;
  try {
    response = await deps.telnyx.request("GET", `/conferences/${encodeURIComponent(operation.conferenceId)}/participants`,
      { query: { region: "Europe", "page[number]": 1, "page[size]": 250 } });
  } catch { return result("provider_query_failed", true); }
  const observedAt = deps.now().toISOString();
  const body = record(response), meta = record(body.meta);
  if (!Array.isArray(body.data) || body.data.length > 250 || meta.page_number !== 1) return result("provider_response_invalid", true);
  const customerRows = body.data.filter(row => record(row).call_control_id === operation.customerControlId);
  const operatorRows = body.data.filter(row => record(row).call_control_id === operation.operatorControlId);
  if (customerRows.length !== 1 || operatorRows.length !== 1) return result("pair_not_observed", true);
  const a = audibleParticipant(customerRows[0], operation.conferenceId, operation.customerControlId, customerLegId);
  const b = audibleParticipant(operatorRows[0], operation.conferenceId, operation.operatorControlId, operatorLegId);
  if (!a || !b || a.id === b.id) return result("pair_not_audible", true);
  // The snapshot was requested for this immutable operation; the caller's CAS
  // rejects concurrent topology changes before committing it.
  const snapshot: ConferenceContactSnapshot = { source: "telnyx_conference_participants_v1", conferenceId: operation.conferenceId, requestedAt, observedAt, participants: [a, b] };
  const proof: ContactProof = { version: 1, id: `contact:${operation.id}`, operationId: operation.id, sessionId: state.session.id, scope: operation.scope,
    occurredAt: observedAt, customerLegId: operation.customerLegId, operatorLegId: operation.operatorLegId, operatorProfileId: operation.operatorProfileId,
    customerControlId: operation.customerControlId, operatorControlId: operation.operatorControlId,
    topology: "conference", conferenceId: operation.conferenceId, conferenceSnapshot: snapshot,
    eventIds: [`snapshot:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24)}`] };
  // Discard any pre-contract inferred conference proof for this operation.
  history.proofs = history.proofs.filter(item => item.operationId !== operationId);
  history.proofs.push(proof);
  return result("verified", false, proof);
}
