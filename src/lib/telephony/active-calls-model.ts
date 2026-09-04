/**
 * Client-side view of `GET /api/telephony/calls/active` (design §2.4).
 *
 * The console polls that endpoint and this module turns its payload into the
 * two shapes the UI already speaks: `CallCenterCall` rows for the call log /
 * waiting room, and a PhoneBar model describing what *this* operator is doing
 * right now. It is deliberately pure so it can be tested without a DOM.
 *
 * The payload types are declared here rather than imported from
 * `src/server/telephony/active-calls.ts`: the console must not pull server
 * modules into the browser bundle. `active-calls-model.test.ts` asserts at
 * compile time that the server snapshot is assignable to these types.
 */

import type { CallCenterCall, CallerMatch } from "@/data/dispatch-types";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { TelephonyPresenceSnapshot, TelephonyPresenceStatus } from "@/lib/telephony/presence";

export type ActiveCallSessionState =
  | "received"
  | "greeting"
  | "ivr"
  | "ringing"
  | "talking"
  | "held"
  | "consulting"
  | "conference"
  | "parked"
  | "waiting"
  | "after_hours"
  | "callback_offered"
  | "wrap_up"
  | "missed"
  | "ended"
  | "failed";

export type ActiveCallDirection = "inbound" | "outbound" | "internal";

export type ActiveCallLegPayload = {
  id: string;
  role: "customer" | "operator" | "consult" | "supervisor" | "external";
  profileId: string | null;
  state: string;
  toNumber: string | null;
  fromNumber: string | null;
  answeredAt: string | null;
  bridgedAt: string | null;
  /** `client_state.intent`; `party` marks a third party added to the conference. */
  intent: string | null;
  muted: boolean;
  /** `monitor` / `whisper` / `barge` for a supervisor leg. */
  supervisorMode: string | null;
};

export type ActiveCallPayload = {
  sessionId: string;
  /** `motorist_calls.id` of the log row (link-case / outcome), null until it exists. */
  callId: string | null;
  state: ActiveCallSessionState;
  direction: ActiveCallDirection;
  callerNumber: string | null;
  calledNumber: string | null;
  lineId: string | null;
  lineLabel: string | null;
  partnerName: string | null;
  caseId: string | null;
  match: { top: CallerMatch | null; count: number; degraded: boolean } | null;
  startedAt: string;
  answeredAt: string | null;
  answeredByProfileId: string | null;
  holdStartedAt: string | null;
  parkedAt: string | null;
  parkedByProfileId: string | null;
  waitingSince: string | null;
  waitingReason: string | null;
  waitingMaxMinutes: number | null;
  currentStep: number;
  ringMode: string | null;
  offeredProfileIds: string[];
  legs: ActiveCallLegPayload[];
  mine: boolean;
};

export type ActiveCallsPayload = {
  checkedAt: string;
  configured: boolean;
  /** Organisation whose Realtime topic carries telephony changes. */
  organizationId: string;
  actorProfileId: string;
  calls: ActiveCallPayload[];
  waiting: ActiveCallPayload[];
  presence: TelephonyPresenceSnapshot;
};

export const EMPTY_ACTIVE_CALLS: ActiveCallsPayload = {
  checkedAt: "",
  configured: false,
  organizationId: "",
  actorProfileId: "",
  calls: [],
  waiting: [],
  presence: { actorProfileId: "", canManageAssignments: false, checkedAt: "", devices: [], presence: [] },
};

const TALKING_STATES = new Set<ActiveCallSessionState>(["talking", "held", "consulting", "conference"]);
const WAITING_STATES = new Set<ActiveCallSessionState>(["waiting", "parked"]);

export function isTalkingState(state: ActiveCallSessionState): boolean {
  return TALKING_STATES.has(state);
}

export function isWaitingState(state: ActiveCallSessionState): boolean {
  return WAITING_STATES.has(state);
}

/**
 * Same derivation as the server's `callStatusForSession`, restricted to the
 * `CallCenterCall` union the rest of the console already renders. A waiting or
 * parked customer stays "incoming" so the čakáreň keeps its amber treatment.
 */
export function callCenterStatusFor(call: Pick<ActiveCallPayload, "state" | "direction" | "answeredAt">): CallCenterCall["status"] {
  const outward = call.direction === "outbound" || call.direction === "internal";
  switch (call.state) {
    case "received":
    case "greeting":
    case "ivr":
    case "after_hours":
    case "callback_offered":
      return outward ? "outbound" : "incoming";
    case "ringing":
      return outward ? "outbound" : "ringing_agent";
    case "waiting":
    case "parked":
      return outward ? "outbound" : "incoming";
    case "talking":
    case "held":
    case "consulting":
    case "conference":
      return "answered";
    case "missed":
      return "missed";
    case "failed":
      return "failed";
    case "wrap_up":
    case "ended":
      return call.answeredAt ? "ended" : outward ? "ended" : "missed";
    default:
      return "incoming";
  }
}

export type OperatorNameLookup = (profileId: string) => string | undefined;

/** Number of the far end (customer), whichever direction the call has. */
export function counterpartNumber(call: Pick<ActiveCallPayload, "direction" | "callerNumber" | "calledNumber">): string {
  return (call.direction === "inbound" ? call.callerNumber : call.calledNumber) ?? "";
}

export function callCenterCallFromActive(
  call: ActiveCallPayload,
  options: { now: number; operatorName?: OperatorNameLookup; caseNumber?: (caseId: string) => string | undefined } = { now: Date.now() },
): CallCenterCall {
  const startedAt = Date.parse(call.startedAt);
  const answeredAt = call.answeredAt ? Date.parse(call.answeredAt) : null;
  const waitSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor(((answeredAt && Number.isFinite(answeredAt) ? answeredAt : options.now) - startedAt) / 1_000))
    : 0;
  const operatorId = call.answeredByProfileId ?? undefined;
  const durationSeconds =
    answeredAt && Number.isFinite(answeredAt) ? Math.max(0, Math.floor((options.now - answeredAt) / 1_000)) : undefined;

  return {
    // The call-log routes (`link-case`, `outcome`) are keyed on the log row, so
    // a live session uses that id as soon as the row exists.
    id: call.callId ?? call.sessionId,
    providerSessionId: call.sessionId,
    status: callCenterStatusFor(call),
    direction: call.direction,
    callerNumber: call.callerNumber ?? "",
    calledNumber: call.calledNumber ?? "",
    ...(call.match?.top?.label && call.match.top.type !== "previous_call" ? { callerName: call.match.top.label } : {}),
    ...(call.lineId ? { lineId: call.lineId } : {}),
    lineLabel: call.lineLabel ?? call.partnerName ?? "Neznáma linka",
    ...(call.partnerName ? { queueLabel: call.partnerName } : {}),
    ...(operatorId ? { operatorId } : {}),
    ...(operatorId && options.operatorName?.(operatorId) ? { operatorName: options.operatorName(operatorId) } : {}),
    ...(call.caseId ? { caseId: call.caseId } : {}),
    ...(call.caseId && options.caseNumber?.(call.caseId) ? { caseNumber: options.caseNumber(call.caseId) } : {}),
    startedAt: call.startedAt,
    ...(call.answeredAt ? { answeredAt: call.answeredAt } : {}),
    waitSeconds,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: [],
  };
}

// --- PhoneBar model ----------------------------------------------------------

export type PhoneBarCallKind = "active" | "offer" | "waiting";

export type PhoneBarCall = {
  sessionId: string;
  callId: string | null;
  kind: PhoneBarCallKind;
  state: ActiveCallSessionState;
  direction: ActiveCallDirection;
  /** Line label + partner, e.g. "Allianz Assistance". */
  lineLabel: string;
  partnerName: string | null;
  number: string;
  callerName: string | null;
  caseId: string | null;
  match: CallerMatch | null;
  matchCount: number;
  /** Timer origin: answer time once answered, otherwise the call start. */
  timerSince: string;
  answered: boolean;
  held: boolean;
  parked: boolean;
  consulting: boolean;
  conference: boolean;
  /** True when this operator owns the call rather than merely watching it. */
  mine: boolean;
  /** The operator that currently owns the connected call, if any. */
  operatorProfileId: string | null;
  operatorName: string | null;
  /** Operators whose devices are ringing before one of them answers. */
  offeredProfileIds: string[];
  offeredOperatorNames: string[];
  offeredToMe: boolean;
  /** Everyone on the call right now: caller, operator, added parties, supervisors. */
  participants: CallParticipant[];
};

export type CallParticipantKind = "caller" | "operator" | "party" | "supervisor" | "consult";

export type CallParticipant = {
  /** `motorist_call_legs.id` — the id the party routes are keyed on. */
  legId: string;
  kind: CallParticipantKind;
  profileId: string | null;
  name: string;
  /** Secondary line: the number behind a colleague, or the supervision mode. */
  detail: string | null;
  answered: boolean;
  muted: boolean;
  supervisorMode: string | null;
  /** The operator reading the bar. */
  self: boolean;
  /** Only added third parties may be muted or thrown out. */
  controllable: boolean;
};

function participantKind(leg: ActiveCallLegPayload): CallParticipantKind {
  if (leg.role === "customer") return "caller";
  if (leg.role === "supervisor") return "supervisor";
  if (leg.role === "consult") return "consult";
  return leg.intent === "party" ? "party" : "operator";
}

/**
 * The participant list the PhoneBar renders during a conference.
 *
 * Only legs the console can address are listed (a leg row always has an id);
 * `controllable` marks the third parties the mute/kick routes accept, so the
 * caller and the operator's own leg cannot be muted away by a mis-click.
 */
export function callParticipants(
  call: Pick<ActiveCallPayload, "legs" | "direction" | "callerNumber" | "calledNumber">,
  options: { actorProfileId: string; operatorName?: OperatorNameLookup },
): CallParticipant[] {
  const order: Record<CallParticipantKind, number> = { caller: 0, operator: 1, party: 2, consult: 3, supervisor: 4 };
  return call.legs
    .map((leg) => {
      const kind = participantKind(leg);
      const number = kind === "caller" ? counterpartNumber(call) : (leg.toNumber ?? leg.fromNumber ?? "");
      const name =
        (leg.profileId ? options.operatorName?.(leg.profileId) : undefined) ??
        (number ? formatPhoneNumberForDisplay(number) || number : null) ??
        (kind === "caller" ? "Volajúci" : "Účastník");
      return {
        legId: leg.id,
        kind,
        profileId: leg.profileId,
        name,
        detail: leg.profileId && number ? (formatPhoneNumberForDisplay(number) || number) : null,
        answered: Boolean(leg.answeredAt),
        muted: leg.muted,
        supervisorMode: leg.supervisorMode,
        self: leg.profileId === options.actorProfileId,
        controllable: kind === "party",
      } satisfies CallParticipant;
    })
    .sort((left, right) => order[left.kind] - order[right.kind] || left.name.localeCompare(right.name, "sk"));
}

export type PhoneBarModel = {
  checkedAt: string;
  configured: boolean;
  /** The call this operator is on (or the one ringing that they picked up). */
  active: PhoneBarCall | null;
  /** Calls ringing at this operator's phone right now. */
  offers: PhoneBarCall[];
  /** Waiting room (parked / overflow) — org-wide, anyone may pick these up. */
  waiting: PhoneBarCall[];
  /** Live calls of other operators, for the "prebieha" counter. */
  otherActiveCount: number;
  /** Live calls of other operators that still have an operator on them — the supervision targets of a manager. */
  others: PhoneBarCall[];
  /** Every non-terminal organisation call, once each, for shared live overviews. */
  teamCalls: PhoneBarCall[];
  /** The call this operator is supervising right now (their own supervisor leg is up). */
  supervising: { sessionId: string; mode: string | null; pending: boolean } | null;
  presence: TelephonyPresenceSnapshot;
  ownPresenceStatus: TelephonyPresenceStatus | null;
};

export type PhoneBarModelOptions = { operatorName?: OperatorNameLookup };

function toPhoneBarCall(call: ActiveCallPayload, kind: PhoneBarCallKind, actorProfileId: string, options: PhoneBarModelOptions = {}): PhoneBarCall {
  return {
    sessionId: call.sessionId,
    callId: call.callId,
    kind,
    state: call.state,
    direction: call.direction,
    lineLabel: call.lineLabel ?? call.partnerName ?? "Neznáma linka",
    partnerName: call.partnerName,
    number: counterpartNumber(call),
    callerName: call.match?.top?.label ?? null,
    caseId: call.caseId,
    match: call.match?.top ?? null,
    matchCount: call.match?.count ?? 0,
    timerSince: call.answeredAt ?? call.startedAt,
    answered: Boolean(call.answeredAt),
    held: call.state === "held",
    parked: call.state === "parked" || call.state === "waiting",
    consulting: call.state === "consulting",
    conference: call.state === "conference",
    mine: call.answeredByProfileId === actorProfileId,
    operatorProfileId: call.answeredByProfileId,
    operatorName: call.answeredByProfileId ? options.operatorName?.(call.answeredByProfileId) ?? null : null,
    offeredProfileIds: [...call.offeredProfileIds],
    offeredOperatorNames: call.offeredProfileIds.map((profileId) => options.operatorName?.(profileId)).filter((name): name is string => Boolean(name)),
    offeredToMe: call.offeredProfileIds.includes(actorProfileId),
    participants: callParticipants(call, { actorProfileId, operatorName: options.operatorName }),
  };
}

function teamCallKind(call: ActiveCallPayload): PhoneBarCallKind {
  if (WAITING_STATES.has(call.state)) return "waiting";
  if (isTalkingState(call.state)) return "active";
  return "offer";
}

function teamCallPriority(call: PhoneBarCall): number {
  if (call.kind === "offer") return 0;
  if (call.kind === "waiting") return 1;
  return 2;
}

/**
 * Splits the snapshot into what the top call bar shows.
 *
 * "Active" is the call this operator is talking on; an offer is a session
 * ringing at their phone (`offeredProfileIds`), which becomes the active call
 * the moment the reservation names them. Waiting-room rows are everyone's.
 */
export function buildPhoneBarModel(payload: ActiveCallsPayload, options: PhoneBarModelOptions = {}): PhoneBarModel {
  const actorProfileId = payload.actorProfileId;
  const active =
    payload.calls.find((call) => call.answeredByProfileId === actorProfileId && !WAITING_STATES.has(call.state)) ?? null;
  const offers = payload.calls.filter(
    (call) => call.offeredProfileIds.includes(actorProfileId) && call.sessionId !== active?.sessionId,
  );
  const waiting = payload.waiting;
  const others = payload.calls.filter((call) => isTalkingState(call.state) && call.answeredByProfileId !== actorProfileId);
  // Supervision whispers into the leg that answered the caller. A three-way the
  // operator already left has no colleague on it any more (`answered_by_profile_id`
  // is null and the remaining leg is the outside party), so it is not a target:
  // the server refuses it with 409 and offering the buttons would only teach the
  // manager to press a button that never works.
  const supervisable = others.filter((call) => call.answeredByProfileId !== null);
  // The supervisor's own leg on somebody else's call: it is what tells the bar
  // to offer "ukončiť dozor" and which mode is currently in force.
  const supervisedCall = payload.calls.find((call) =>
    call.legs.some((leg) => leg.role === "supervisor" && leg.profileId === actorProfileId),
  );
  const supervisorLeg = supervisedCall?.legs.find((leg) => leg.role === "supervisor" && leg.profileId === actorProfileId) ?? null;
  const teamBySession = new Map<string, ActiveCallPayload>();
  for (const call of [...payload.calls, ...payload.waiting]) teamBySession.set(call.sessionId, call);
  const teamCalls = [...teamBySession.values()]
    .map((call) => toPhoneBarCall(call, teamCallKind(call), actorProfileId, options))
    .sort((left, right) => teamCallPriority(left) - teamCallPriority(right) || Date.parse(left.timerSince) - Date.parse(right.timerSince));

  return {
    checkedAt: payload.checkedAt,
    configured: payload.configured,
    active: active ? toPhoneBarCall(active, "active", actorProfileId, options) : null,
    offers: offers.map((call) => toPhoneBarCall(call, "offer", actorProfileId, options)),
    waiting: waiting.map((call) => toPhoneBarCall(call, "waiting", actorProfileId, options)),
    otherActiveCount: others.length,
    others: supervisable.map((call) => toPhoneBarCall(call, "active", actorProfileId, options)),
    teamCalls,
    supervising:
      supervisedCall && supervisorLeg
        ? { sessionId: supervisedCall.sessionId, mode: supervisorLeg.supervisorMode, pending: !supervisorLeg.answeredAt }
        : null,
    presence: payload.presence,
    ownPresenceStatus: payload.presence.presence.find((row) => row.profileId === actorProfileId)?.status ?? null,
  };
}

/** Poll activity input for `poll-schedule.ts`: an offer counts as engaged. */
export function pollActivityInput(model: PhoneBarModel): { hasBrowserCall: boolean; liveCallCount: number } {
  return {
    hasBrowserCall: Boolean(model.active) || model.offers.length > 0,
    liveCallCount: model.offers.length + model.waiting.length + model.otherActiveCount,
  };
}

/**
 * What the waiting room says about a caller beyond the call row itself: who put
 * them there and how long they have before the park limit turns into a callback
 * offer.
 *
 * A caller nobody rescues is not left in the waiting room forever — the state
 * machine offers them a callback once `park_max_minutes` (frozen when they
 * entered, `meta.waiting.max_minutes`) runs out. The dispatcher has to be able
 * to see that clock, otherwise the caller disappears from the queue with no
 * explanation on screen.
 */
export type WaitingRoomPark = {
  /** True for `parked`: an operator put this caller here, they did not overflow into it. */
  parked: boolean;
  byProfileId: string | null;
  byName: string | null;
  /** ISO moment the caller entered the waiting room. */
  since: string | null;
  /** Seconds spent in the waiting room, measured against the snapshot clock. */
  seconds: number;
  /** Seconds left before the callback offer; `null` when the limit is unknown. */
  secondsToLimit: number | null;
  limitMinutes: number | null;
};

export function waitingRoomPark(
  call: Pick<ActiveCallPayload, "state" | "parkedAt" | "parkedByProfileId" | "waitingSince" | "waitingMaxMinutes">,
  options: { now: number; operatorName?: OperatorNameLookup },
): WaitingRoomPark {
  const parked = call.state === "parked";
  // `parked_at` is stamped by the park action; the overflow path only has the
  // waiting-room timestamp.
  const since = call.parkedAt ?? call.waitingSince;
  const started = since ? Date.parse(since) : Number.NaN;
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((options.now - started) / 1_000)) : 0;
  const limitMinutes = call.waitingMaxMinutes && call.waitingMaxMinutes > 0 ? call.waitingMaxMinutes : null;
  const byProfileId = parked ? call.parkedByProfileId : null;
  return {
    parked,
    byProfileId,
    byName: byProfileId ? options.operatorName?.(byProfileId) ?? null : null,
    since,
    seconds,
    secondsToLimit: limitMinutes === null || !Number.isFinite(started) ? null : Math.max(0, limitMinutes * 60 - seconds),
    limitMinutes,
  };
}

export type WaitingRoomRow = { call: CallCenterCall; park: WaitingRoomPark };

/** Waiting-room rows for `CallQueuePanel` (which speaks `CallCenterCall`). */
export function waitingRoomCalls(
  payload: ActiveCallsPayload,
  options: { now: number; operatorName?: OperatorNameLookup },
): WaitingRoomRow[] {
  return payload.waiting.map((call) => ({
    call: callCenterCallFromActive(call, options),
    park: waitingRoomPark(call, options),
  }));
}

/** Live rows for the Ústredňa list: everything that is not waiting. */
export function liveCallCenterCalls(
  payload: ActiveCallsPayload,
  options: { now: number; operatorName?: OperatorNameLookup; caseNumber?: (caseId: string) => string | undefined },
): CallCenterCall[] {
  return payload.calls.filter((call) => !WAITING_STATES.has(call.state)).map((call) => callCenterCallFromActive(call, options));
}

/**
 * Merges live sessions into the stored call history.
 *
 * A session that is already in the history (same id) is replaced by its live
 * row, so a call does not appear twice while it is both live and logged.
 */
export function mergeCallCenterCalls(live: CallCenterCall[], history: CallCenterCall[]): CallCenterCall[] {
  const liveIds = new Set(live.map((call) => call.id));
  return [...live, ...history.filter((call) => !liveIds.has(call.id))];
}
