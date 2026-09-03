import { describe, expect, it } from "vitest";

import {
  callbackDeadline,
  callbackPermissions,
  callbackQueueSummary,
  callbackUrgency,
  callbackWaitSeconds,
  canTakeOverCallback,
  formatCallbackWait,
  sortCallbackQueue,
  CALLBACK_OVERDUE_MINUTES,
  CALLBACK_WARN_MINUTES,
  type CallbackRequestPayload,
} from "./callback-queue";

const NOW = Date.parse("2026-09-03T09:00:00.000Z");
const ME = "profile-me";
const COLLEAGUE = "profile-colleague";

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function request(overrides: Partial<CallbackRequestPayload> = {}): CallbackRequestPayload {
  const createdAt = overrides.createdAt ?? minutesAgo(5);
  const created = Date.parse(createdAt);
  return {
    id: "cb-1",
    callerNumber: "+421905123456",
    callerName: null,
    source: "ivr",
    status: "open",
    lineId: "line-1",
    lineLabel: "Allianz Assistance",
    partnerName: "Allianz",
    caseId: null,
    sessionId: "sess-1",
    claimedByProfileId: null,
    claimedByName: null,
    claimedAt: null,
    dueAt: Number.isFinite(created) ? new Date(created + CALLBACK_OVERDUE_MINUTES * 60_000).toISOString() : null,
    createdAt,
    resolvedAt: null,
    notes: null,
    lastCallSessionId: null,
    lastCalledAt: null,
    ...overrides,
  };
}

describe("callbackWaitSeconds", () => {
  it("measures against now while the request is open", () => {
    expect(callbackWaitSeconds(request({ createdAt: minutesAgo(7) }), NOW)).toBe(7 * 60);
  });

  it("freezes at the moment the request was resolved", () => {
    const row = request({ createdAt: minutesAgo(40), resolvedAt: minutesAgo(30), status: "done" });
    expect(callbackWaitSeconds(row, NOW)).toBe(10 * 60);
  });

  it("never goes negative and survives an unparsable timestamp", () => {
    expect(callbackWaitSeconds(request({ createdAt: new Date(NOW + 60_000).toISOString() }), NOW)).toBe(0);
    expect(callbackWaitSeconds(request({ createdAt: "not a date" }), NOW)).toBe(0);
  });
});

describe("callbackDeadline", () => {
  it("uses the promise written when the request was created", () => {
    const row = request({ createdAt: minutesAgo(10), dueAt: minutesAgo(-5) });
    expect(callbackDeadline(row)).toBe(NOW + 5 * 60_000);
  });

  it("falls back to created + 30 minutes when the column is empty", () => {
    // A row without `due_at` must not age silently: without the fallback it
    // would never turn amber, let alone red.
    const row = request({ createdAt: minutesAgo(10), dueAt: null });
    expect(callbackDeadline(row)).toBe(NOW - 10 * 60_000 + CALLBACK_OVERDUE_MINUTES * 60_000);
  });

  it("has no deadline when neither timestamp parses", () => {
    expect(callbackDeadline(request({ createdAt: "x", dueAt: null }))).toBeNull();
  });
});

describe("callbackUrgency", () => {
  it("turns amber for the last quarter hour of the promise and red once it breaks", () => {
    expect(callbackUrgency(request({ createdAt: minutesAgo(1) }), NOW)).toBe("fresh");
    expect(callbackUrgency(request({ createdAt: minutesAgo(CALLBACK_OVERDUE_MINUTES - CALLBACK_WARN_MINUTES - 1) }), NOW)).toBe("fresh");
    expect(callbackUrgency(request({ createdAt: minutesAgo(CALLBACK_OVERDUE_MINUTES - CALLBACK_WARN_MINUTES) }), NOW)).toBe("due");
    expect(callbackUrgency(request({ createdAt: minutesAgo(CALLBACK_OVERDUE_MINUTES - 1) }), NOW)).toBe("due");
    expect(callbackUrgency(request({ createdAt: minutesAgo(CALLBACK_OVERDUE_MINUTES) }), NOW)).toBe("overdue");
    expect(callbackUrgency(request({ createdAt: minutesAgo(90) }), NOW)).toBe("overdue");
  });

  it("keeps the warning window relative to a longer promise", () => {
    // A request whose `due_at` is an hour out is amber only in its last 15
    // minutes, not from the 15-minute mark of a promise it never made.
    const row = request({ createdAt: minutesAgo(30), dueAt: new Date(NOW + 20 * 60_000).toISOString() });
    expect(callbackUrgency(row, NOW)).toBe("fresh");
    expect(callbackUrgency(row, NOW + 6 * 60_000)).toBe("due");
    expect(callbackUrgency(row, NOW + 21 * 60_000)).toBe("overdue");
  });

  it("never colours a settled request", () => {
    expect(callbackUrgency(request({ createdAt: minutesAgo(120), status: "done" }), NOW)).toBe("fresh");
    expect(callbackUrgency(request({ createdAt: minutesAgo(120), status: "cancelled" }), NOW)).toBe("fresh");
  });
});

describe("sortCallbackQueue", () => {
  it("is FIFO by age, with the id as a stable tie-break", () => {
    const rows = [
      request({ id: "b", createdAt: minutesAgo(5) }),
      request({ id: "c", createdAt: minutesAgo(40) }),
      request({ id: "a", createdAt: minutesAgo(5) }),
    ];
    expect(sortCallbackQueue(rows).map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  it("does not reorder as rows age, and leaves the input alone", () => {
    // Colour carries urgency, order does not: a queue that re-sorts itself
    // moves the button out from under the dispatcher's cursor.
    const rows = [request({ id: "old", createdAt: minutesAgo(40) }), request({ id: "new", createdAt: minutesAgo(1) })];
    const sorted = sortCallbackQueue(rows);
    expect(sorted.map((row) => row.id)).toEqual(["old", "new"]);
    expect(rows.map((row) => row.id)).toEqual(["old", "new"]);
  });
});

describe("callbackQueueSummary", () => {
  it("counts what the header shows", () => {
    const rows = [
      request({ id: "1", createdAt: minutesAgo(45) }),
      request({ id: "2", createdAt: minutesAgo(20), claimedByProfileId: ME, status: "scheduled" }),
      request({ id: "3", createdAt: minutesAgo(3), claimedByProfileId: COLLEAGUE, status: "scheduled" }),
    ];
    expect(callbackQueueSummary(rows, { now: NOW, actorProfileId: ME })).toEqual({
      total: 3,
      unclaimed: 1,
      mine: 1,
      overdue: 1,
      longestWaitSeconds: 45 * 60,
    });
  });

  it("is all zeroes for an empty queue", () => {
    expect(callbackQueueSummary([], { now: NOW, actorProfileId: ME })).toEqual({
      total: 0,
      unclaimed: 0,
      mine: 0,
      overdue: 0,
      longestWaitSeconds: 0,
    });
  });
});

describe("callbackPermissions", () => {
  it("offers every action on a free request", () => {
    expect(callbackPermissions(request(), { profileId: ME, role: "dispatcher" })).toEqual({
      canClaim: true,
      canCall: true,
      canResolve: true,
      blockedReason: null,
    });
  });

  it("stops offering the claim to the operator who already holds it", () => {
    const mine = request({ claimedByProfileId: ME, status: "scheduled" });
    expect(callbackPermissions(mine, { profileId: ME, role: "dispatcher" })).toMatchObject({ canClaim: false, canCall: true, canResolve: true });
  });

  it("locks a request another dispatcher holds and names them", () => {
    const theirs = request({ claimedByProfileId: COLLEAGUE, claimedByName: "Peter", status: "scheduled" });
    expect(callbackPermissions(theirs, { profileId: ME, role: "dispatcher" })).toEqual({
      canClaim: false,
      canCall: false,
      canResolve: false,
      blockedReason: "Požiadavku má prevzatú Peter.",
    });
  });

  it("lets a senior dispatcher take over a colleague who went home", () => {
    const theirs = request({ claimedByProfileId: COLLEAGUE, claimedByName: "Peter", status: "scheduled" });
    expect(callbackPermissions(theirs, { profileId: ME, role: "senior_dispatcher" })).toMatchObject({ canClaim: true, canCall: true });
    expect(canTakeOverCallback({ profileId: ME, role: "dispatcher" })).toBe(false);
    expect(canTakeOverCallback({ profileId: ME, role: "manager" })).toBe(true);
  });

  it("offers nothing on a settled request", () => {
    for (const status of ["done", "cancelled"] as const) {
      expect(callbackPermissions(request({ status }), { profileId: ME, role: "admin" })).toEqual({
        canClaim: false,
        canCall: false,
        canResolve: false,
        blockedReason: "Požiadavka je už uzavretá.",
      });
    }
  });
});

describe("formatCallbackWait", () => {
  it("reads in minutes and hours, never in seconds", () => {
    expect(formatCallbackWait(0)).toBe("< 1 min");
    expect(formatCallbackWait(59)).toBe("< 1 min");
    expect(formatCallbackWait(60)).toBe("1 min");
    expect(formatCallbackWait(45 * 60)).toBe("45 min");
    expect(formatCallbackWait(60 * 60)).toBe("1 h");
    expect(formatCallbackWait(72 * 60)).toBe("1 h 12 min");
    expect(formatCallbackWait(-5)).toBe("< 1 min");
  });
});
