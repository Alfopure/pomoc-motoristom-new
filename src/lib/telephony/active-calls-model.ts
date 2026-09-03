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
};

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
  presence: TelephonyPresenceSnapshot;
  ownPresenceStatus: TelephonyPresenceStatus | null;
};

function toPhoneBarCall(call: ActiveCallPayload, kind: PhoneBarCallKind, actorProfileId: string): PhoneBarCall {
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
  };
}

/**
 * Splits the snapshot into what the top call bar shows.
 *
 * "Active" is the call this operator is talking on; an offer is a session
 * ringing at their phone (`offeredProfileIds`), which becomes the active call
 * the moment the reservation names them. Waiting-room rows are everyone's.
 */
export function buildPhoneBarModel(payload: ActiveCallsPayload): PhoneBarModel {
  const actorProfileId = payload.actorProfileId;
  const active =
    payload.calls.find((call) => call.answeredByProfileId === actorProfileId && !WAITING_STATES.has(call.state)) ?? null;
  const offers = payload.calls.filter(
    (call) => call.offeredProfileIds.includes(actorProfileId) && call.sessionId !== active?.sessionId,
  );
  const waiting = payload.waiting;
  const otherActiveCount = payload.calls.filter(
    (call) => isTalkingState(call.state) && call.answeredByProfileId !== actorProfileId,
  ).length;

  return {
    checkedAt: payload.checkedAt,
    configured: payload.configured,
    active: active ? toPhoneBarCall(active, "active", actorProfileId) : null,
    offers: offers.map((call) => toPhoneBarCall(call, "offer", actorProfileId)),
    waiting: waiting.map((call) => toPhoneBarCall(call, "waiting", actorProfileId)),
    otherActiveCount,
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
