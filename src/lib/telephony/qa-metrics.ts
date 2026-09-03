/**
 * Quality metrics for a call centre that keeps no recordings (plan "Fáza 4",
 * "QA bez prepisov").
 *
 * The old QA dashboard scored calls from AI transcripts. Recording, voicemail
 * audio and transcription are out of scope by the owner's decision, so
 * `motorist_call_transcripts` is never written and that dashboard has been
 * showing nothing at all. What is left is still worth measuring, and it is
 * arguably the more honest half: **did the dispatcher write down what happened
 * to the call, and did we keep the promises we made to the people we did not
 * reach.** Both are facts the application already records.
 *
 * Everything here is pure and shared: `src/server/telephony/qa.ts` fills the
 * payload from the database and `QaDashboard.tsx` renders it, so the two cannot
 * disagree about what "vybavené načas" means.
 */

import type { CallOutcome } from "@/data/dispatch-types";

import { callbackDeadline, type CallbackSource, type CallbackStatus } from "./callback-queue";

/**
 * Thirty days, and not by taste: the outcome is stored inside
 * `motorist_calls.raw_latest_payload`, which the retention job empties at
 * thirty days (`docs/telnyx-data-contract.md`). A longer window would quietly
 * report older calls as undocumented once the prune ran.
 */
export const QA_LOOKBACK_DAYS = 30;

/** The vocabulary of `setCallOutcome`; the same labels the console offers. */
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  reached: "Dovolané",
  not_reached: "Nedovolané",
  callback: "Zavolať naspäť",
  informational: "Informačný hovor",
  bad_contact: "Nesprávny kontakt",
  case_created: "Prípad vytvorený",
};

export const CALL_OUTCOMES = Object.keys(CALL_OUTCOME_LABELS) as CallOutcome[];

export function isCallOutcomeValue(value: unknown): value is CallOutcome {
  return typeof value === "string" && value in CALL_OUTCOME_LABELS;
}

export type QaOutcomeSlice = { outcome: CallOutcome; label: string; calls: number };

export type QaOperatorRow = {
  profileId: string;
  name: string;
  /** Answered calls that ended in the window — the calls that could be documented. */
  calls: number;
  documented: number;
  documentedRate: number | null;
  callbacksHandled: number;
  callbacksOnTime: number;
  callbacksOnTimeRate: number | null;
};

export type QaCallbackCompliance = {
  created: number;
  done: number;
  cancelled: number;
  open: number;
  /** Open past the promise, or settled after it. */
  overdue: number;
  /** Done inside the promised window. */
  onTime: number;
  /** Requests that owed a call back and could be timed — the rate's denominator. */
  measured: number;
  onTimeRate: number | null;
  /** Minutes from the request to the call back, over the requests we settled. */
  averageMinutesToClose: number | null;
  medianMinutesToClose: number | null;
  bySource: Array<{ source: CallbackSource; calls: number; done: number }>;
};

export type QaDashboardPayload = {
  checkedAt: string;
  lookbackDays: number;
  /** Both false by owner decision; the screen says so instead of showing empty controls. */
  recordingEnabled: boolean;
  transcriptsEnabled: boolean;
  promiseMinutes: number;
  calls: {
    /** Calls that ended in the window and could carry an outcome. */
    completed: number;
    documented: number;
    documentedRate: number | null;
    /** Documented calls that also ended up attached to a case. */
    linkedToCase: number;
    linkedRate: number | null;
    byOutcome: QaOutcomeSlice[];
  };
  callbacks: QaCallbackCompliance;
  operators: QaOperatorRow[];
};

export function qaPercentage(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** Green from 80 %, amber from 50 %, red below — the same bar for both rates. */
export type QaTone = "ok" | "warn" | "alert" | "idle";

export function qaTone(rate: number | null): QaTone {
  if (rate === null) return "idle";
  if (rate >= 80) return "ok";
  if (rate >= 50) return "warn";
  return "alert";
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** What the aggregation needs of one `motorist_calls` row. */
export type QaCallInput = {
  operatorId: string | null;
  /** `raw_latest_payload.outcome`, already narrowed. */
  outcome: CallOutcome | null;
  caseId: string | null;
  /** A call still in progress cannot be judged for documentation yet. */
  completed: boolean;
};

export function aggregateCallQuality(calls: QaCallInput[]): QaDashboardPayload["calls"] {
  const byOutcome = new Map<CallOutcome, number>();
  let completed = 0;
  let documented = 0;
  let linkedToCase = 0;

  for (const call of calls) {
    if (!call.completed) continue;
    completed += 1;
    if (!call.outcome) continue;
    documented += 1;
    if (call.caseId) linkedToCase += 1;
    byOutcome.set(call.outcome, (byOutcome.get(call.outcome) ?? 0) + 1);
  }

  return {
    completed,
    documented,
    documentedRate: qaPercentage(documented, completed),
    linkedToCase,
    linkedRate: qaPercentage(linkedToCase, documented),
    byOutcome: CALL_OUTCOMES.filter((outcome) => byOutcome.has(outcome)).map((outcome) => ({
      outcome,
      label: CALL_OUTCOME_LABELS[outcome],
      calls: byOutcome.get(outcome) ?? 0,
    })).sort((left, right) => right.calls - left.calls),
  };
}

// ---------------------------------------------------------------------------
// Callback compliance
// ---------------------------------------------------------------------------

/** What the aggregation needs of one `motorist_callback_requests` row. */
export type QaCallbackInput = {
  status: CallbackStatus;
  source: CallbackSource;
  claimedBy: string | null;
  createdAt: string;
  dueAt: string | null;
  resolvedAt: string | null;
};

function minutesBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A promise is kept when the caller was rung back before the deadline the
 * request carries (`due_at`, or thirty minutes after it was created). A request
 * that is still open past its deadline is late too — the clock does not stop
 * because nobody looked at the queue.
 *
 * Cancelled requests are counted but are deliberately neither on time nor late:
 * a dispatcher who cancels a duplicate should not be scored for it, and one who
 * cancels to make the number look good is visible in the `cancelled` count.
 */
export function aggregateCallbackCompliance(requests: QaCallbackInput[], now: number): QaCallbackCompliance {
  const bySource = new Map<CallbackSource, { calls: number; done: number }>();
  const durations: number[] = [];
  let done = 0;
  let cancelled = 0;
  let open = 0;
  let overdue = 0;
  let onTime = 0;
  // Settled requests whose timing cannot be established (no `resolved_at`, or a
  // timestamp that will not parse). They are neither praised nor blamed, and
  // they leave the rate's denominator: guessing in either direction would make
  // a compliance number that nobody can check.
  let unmeasured = 0;

  for (const request of requests) {
    const sourceBucket = bySource.get(request.source) ?? { calls: 0, done: 0 };
    sourceBucket.calls += 1;

    const deadline = callbackDeadline({ createdAt: request.createdAt, dueAt: request.dueAt });

    if (request.status === "done") {
      done += 1;
      sourceBucket.done += 1;
      const settledAt = request.resolvedAt ? Date.parse(request.resolvedAt) : Number.NaN;
      const settled = Number.isFinite(settledAt) ? settledAt : null;
      if (deadline === null || settled === null) unmeasured += 1;
      else if (settled <= deadline) onTime += 1;
      else overdue += 1;
      const minutes = request.resolvedAt ? minutesBetween(request.createdAt, request.resolvedAt) : null;
      if (minutes !== null) durations.push(minutes);
    } else if (request.status === "cancelled") {
      cancelled += 1;
    } else {
      open += 1;
      if (deadline !== null && now > deadline) overdue += 1;
    }

    bySource.set(request.source, sourceBucket);
  }

  return {
    created: requests.length,
    done,
    cancelled,
    open,
    overdue,
    onTime,
    measured: done + open - unmeasured,
    // Measured against the requests that had to be called back and could be
    // timed — a cancelled request never had a call owed to it.
    onTimeRate: qaPercentage(onTime, done + open - unmeasured),
    averageMinutesToClose: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    medianMinutesToClose: durations.length > 0 ? Math.round(median(durations) ?? 0) : null,
    bySource: [...bySource.entries()]
      .map(([source, bucket]) => ({ source, ...bucket }))
      .sort((left, right) => right.calls - left.calls),
  };
}

// ---------------------------------------------------------------------------
// Per operator
// ---------------------------------------------------------------------------

export function aggregateQaOperators(input: {
  calls: QaCallInput[];
  callbacks: QaCallbackInput[];
  nameOf: (profileId: string) => string;
}): QaOperatorRow[] {
  const rows = new Map<string, QaOperatorRow>();
  const rowFor = (profileId: string): QaOperatorRow => {
    const existing = rows.get(profileId);
    if (existing) return existing;
    const created: QaOperatorRow = {
      profileId,
      name: input.nameOf(profileId),
      calls: 0,
      documented: 0,
      documentedRate: null,
      callbacksHandled: 0,
      callbacksOnTime: 0,
      callbacksOnTimeRate: null,
    };
    rows.set(profileId, created);
    return created;
  };

  for (const call of input.calls) {
    if (!call.completed || !call.operatorId) continue;
    const row = rowFor(call.operatorId);
    row.calls += 1;
    if (call.outcome) row.documented += 1;
  }

  for (const request of input.callbacks) {
    if (!request.claimedBy || request.status !== "done") continue;
    const row = rowFor(request.claimedBy);
    row.callbacksHandled += 1;
    const deadline = callbackDeadline({ createdAt: request.createdAt, dueAt: request.dueAt });
    const settledAt = request.resolvedAt ? Date.parse(request.resolvedAt) : Number.NaN;
    if (deadline === null || !Number.isFinite(settledAt) || settledAt <= deadline) row.callbacksOnTime += 1;
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      documentedRate: qaPercentage(row.documented, row.calls),
      callbacksOnTimeRate: qaPercentage(row.callbacksOnTime, row.callbacksHandled),
    }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name, "sk"));
}
