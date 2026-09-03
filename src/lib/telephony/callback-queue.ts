/**
 * Client-side view of `GET /api/telephony/callbacks` (design §4 Phase 4).
 *
 * `motorist_callback_requests` rows are written by the call state machine
 * (a caller pressing 1 in the IVR, after hours, when the park limit runs out or
 * when nobody answered). This module turns the queue payload into the numbers
 * the dispatcher sees: how long each caller has been waiting, which requests
 * broke the 30-minute promise, and which actions are open to this operator.
 *
 * It is pure and free of DOM/server imports so both the panel and the server
 * snapshot can agree on the same ageing rules without a round trip: the server
 * answer is up to a poll interval old, so the browser re-derives the durations
 * against its own clock.
 */

export type CallbackSource = "ivr" | "after_hours" | "park_timeout" | "missed" | "manual";
export type CallbackStatus = "open" | "scheduled" | "done" | "cancelled";

export type CallbackRequestPayload = {
  id: string;
  callerNumber: string;
  callerName: string | null;
  source: CallbackSource;
  /** `open` = nobody took it yet, `scheduled` = claimed by an operator. */
  status: CallbackStatus;
  lineId: string | null;
  lineLabel: string | null;
  partnerName: string | null;
  caseId: string | null;
  /** Session of the inbound call that produced the request. */
  sessionId: string | null;
  claimedByProfileId: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  /** Promise moment written when the request was created (creation + 30 min). */
  dueAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  notes: string | null;
  /** Session of the last outbound call started from this request. */
  lastCallSessionId: string | null;
  lastCalledAt: string | null;
};

export type CallbackQueuePayload = {
  checkedAt: string;
  configured: boolean;
  actorProfileId: string;
  /** Role of the polling operator; decides who may take a request over. */
  actorRole: CallbackActorRole;
  /** Live queue: `open` + `scheduled`, oldest first. */
  open: CallbackRequestPayload[];
  /** Closed in the last 24 hours, newest first — context, not a work list. */
  resolved: CallbackRequestPayload[];
};

export const EMPTY_CALLBACK_QUEUE: CallbackQueuePayload = {
  checkedAt: "",
  configured: false,
  actorProfileId: "",
  actorRole: "dispatcher",
  open: [],
  resolved: [],
};

/** Amber from here on: the request has used half of its promise. */
export const CALLBACK_WARN_MINUTES = 15;
/** Red from here on: the 30-minute promise given to the caller is broken. */
export const CALLBACK_OVERDUE_MINUTES = 30;

export type CallbackUrgency = "fresh" | "due" | "overdue";

export const CALLBACK_SOURCE_LABELS: Record<CallbackSource, string> = {
  ivr: "Voľba v menu",
  after_hours: "Mimo otváracích hodín",
  park_timeout: "Vypršala čakáreň",
  missed: "Zmeškaný hovor",
  manual: "Zadané dispečerom",
};

export const CALLBACK_STATUS_LABELS: Record<CallbackStatus, string> = {
  open: "Čaká na prevzatie",
  scheduled: "Prevzaté",
  done: "Vybavené",
  cancelled: "Zrušené",
};

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** How long the caller has been waiting (until it was resolved, if it was). */
export function callbackWaitSeconds(request: CallbackRequestPayload, now: number): number {
  const created = parse(request.createdAt);
  if (created === null) return 0;
  const until = parse(request.resolvedAt) ?? now;
  return Math.max(0, Math.floor((until - created) / 1_000));
}

/**
 * Moment the promise given to the caller expires. `due_at` is written when the
 * request is created; a row without one falls back to the same 30 minutes, so a
 * request never ages silently just because the column is empty.
 */
export function callbackDeadline(request: Pick<CallbackRequestPayload, "dueAt" | "createdAt">): number | null {
  const due = parse(request.dueAt);
  if (due !== null) return due;
  const created = parse(request.createdAt);
  return created === null ? null : created + CALLBACK_OVERDUE_MINUTES * 60_000;
}

export function callbackUrgency(request: Pick<CallbackRequestPayload, "status" | "dueAt" | "createdAt">, now: number): CallbackUrgency {
  if (request.status === "done" || request.status === "cancelled") return "fresh";
  const deadline = callbackDeadline(request);
  if (deadline === null) return "fresh";
  if (now >= deadline) return "overdue";
  // The warning window is the last `CALLBACK_WARN_MINUTES` before the deadline,
  // so a request with a longer promise still turns amber in time.
  return now >= deadline - CALLBACK_WARN_MINUTES * 60_000 ? "due" : "fresh";
}

/**
 * FIFO by age. Colour, not order, carries urgency: a queue that reorders itself
 * as rows turn red moves the button out from under the dispatcher's cursor.
 */
export function sortCallbackQueue(requests: CallbackRequestPayload[]): CallbackRequestPayload[] {
  return [...requests].sort((left, right) => {
    const a = parse(left.createdAt) ?? 0;
    const b = parse(right.createdAt) ?? 0;
    return a - b || left.id.localeCompare(right.id);
  });
}

export type CallbackQueueSummary = {
  total: number;
  /** Nobody has taken these yet. */
  unclaimed: number;
  mine: number;
  overdue: number;
  longestWaitSeconds: number;
};

export function callbackQueueSummary(
  requests: CallbackRequestPayload[],
  options: { now: number; actorProfileId: string },
): CallbackQueueSummary {
  let unclaimed = 0;
  let mine = 0;
  let overdue = 0;
  let longestWaitSeconds = 0;
  for (const request of requests) {
    if (!request.claimedByProfileId) unclaimed += 1;
    else if (request.claimedByProfileId === options.actorProfileId) mine += 1;
    if (callbackUrgency(request, options.now) === "overdue") overdue += 1;
    longestWaitSeconds = Math.max(longestWaitSeconds, callbackWaitSeconds(request, options.now));
  }
  return { total: requests.length, unclaimed, mine, overdue, longestWaitSeconds };
}

export type CallbackActorRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";
export type CallbackActor = { profileId: string; role: CallbackActorRole };

const ROLE_RANK: Record<CallbackActorRole, number> = { dispatcher: 0, senior_dispatcher: 1, manager: 2, admin: 3 };

/** Senior dispatchers and above may take a request over from a colleague who left. */
export function canTakeOverCallback(actor: CallbackActor): boolean {
  return ROLE_RANK[actor.role] >= ROLE_RANK.senior_dispatcher;
}

export type CallbackPermissions = {
  /** Free to take (or to take over, for senior roles). */
  canClaim: boolean;
  canCall: boolean;
  canResolve: boolean;
  /** Why the row is not actionable, for the disabled button's title. */
  blockedReason: string | null;
};

export function callbackPermissions(request: CallbackRequestPayload, actor: CallbackActor): CallbackPermissions {
  if (request.status === "done" || request.status === "cancelled") {
    return { canClaim: false, canCall: false, canResolve: false, blockedReason: "Požiadavka je už uzavretá." };
  }
  const claimant = request.claimedByProfileId;
  const ownedByOther = Boolean(claimant) && claimant !== actor.profileId;
  if (ownedByOther && !canTakeOverCallback(actor)) {
    return {
      canClaim: false,
      canCall: false,
      canResolve: false,
      blockedReason: `Požiadavku má prevzatú ${request.claimedByName ?? "iný dispečer"}.`,
    };
  }
  return { canClaim: claimant !== actor.profileId, canCall: true, canResolve: true, blockedReason: null };
}

/** "7 min", "1 h 12 min" — the queue is measured in minutes, never in seconds. */
export function formatCallbackWait(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
