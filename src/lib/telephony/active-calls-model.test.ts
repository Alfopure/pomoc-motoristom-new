import { describe, expect, it } from "vitest";

import type { ActiveCallsSnapshot } from "@/server/telephony/active-calls";

import {
  buildPhoneBarModel,
  callCenterCallFromActive,
  callCenterStatusFor,
  counterpartNumber,
  liveCallCenterCalls,
  mergeCallCenterCalls,
  pollActivityInput,
  waitingRoomCalls,
  type ActiveCallPayload,
  type ActiveCallsPayload,
} from "./active-calls-model";

const NOW = Date.parse("2026-09-03T08:05:00.000Z");
const ME = "profile-me";
const COLLEAGUE = "profile-colleague";

function call(overrides: Partial<ActiveCallPayload> = {}): ActiveCallPayload {
  return {
    sessionId: "sess-1",
    callId: "call-row-1",
    state: "talking",
    direction: "inbound",
    callerNumber: "+421900111222",
    calledNumber: "+421232408700",
    lineId: "line-1",
    lineLabel: "Allianz Assistance",
    partnerName: "Allianz",
    caseId: null,
    match: null,
    startedAt: "2026-09-03T08:00:00.000Z",
    answeredAt: "2026-09-03T08:00:20.000Z",
    answeredByProfileId: ME,
    holdStartedAt: null,
    parkedAt: null,
    waitingSince: null,
    currentStep: 1,
    ringMode: "all",
    offeredProfileIds: [],
    legs: [],
    mine: true,
    ...overrides,
  };
}

function payload(overrides: Partial<ActiveCallsPayload> = {}): ActiveCallsPayload {
  return {
    checkedAt: "2026-09-03T08:05:00.000Z",
    configured: true,
    actorProfileId: ME,
    calls: [],
    waiting: [],
    presence: {
      actorProfileId: ME,
      canManageAssignments: false,
      checkedAt: "2026-09-03T08:05:00.000Z",
      devices: [{ profileId: ME, registered: true }],
      presence: [{ profileId: ME, status: "on_call", currentSessionId: "sess-1" }],
    },
    ...overrides,
  };
}

describe("snapshot contract", () => {
  it("accepts the server snapshot without importing server code at runtime", () => {
    // Compile-time only: the browser model must stay assignable from the shape
    // `GET /api/telephony/calls/active` actually returns.
    const fromServer = {} as ActiveCallsSnapshot;
    const asClient: ActiveCallsPayload = fromServer;
    expect(typeof asClient).toBe("object");
  });
});

describe("call status mapping", () => {
  it("maps session states onto the existing call-log statuses", () => {
    expect(callCenterStatusFor({ state: "ringing", direction: "inbound", answeredAt: null })).toBe("ringing_agent");
    expect(callCenterStatusFor({ state: "ringing", direction: "outbound", answeredAt: null })).toBe("outbound");
    expect(callCenterStatusFor({ state: "held", direction: "inbound", answeredAt: "x" })).toBe("answered");
    expect(callCenterStatusFor({ state: "waiting", direction: "inbound", answeredAt: null })).toBe("incoming");
    expect(callCenterStatusFor({ state: "parked", direction: "inbound", answeredAt: "x" })).toBe("incoming");
    expect(callCenterStatusFor({ state: "ended", direction: "inbound", answeredAt: null })).toBe("missed");
    expect(callCenterStatusFor({ state: "ended", direction: "inbound", answeredAt: "x" })).toBe("ended");
    expect(callCenterStatusFor({ state: "failed", direction: "outbound", answeredAt: null })).toBe("failed");
  });

  it("uses the far end of the call whichever direction it has", () => {
    expect(counterpartNumber({ direction: "inbound", callerNumber: "+421900", calledNumber: "+421232" })).toBe("+421900");
    expect(counterpartNumber({ direction: "outbound", callerNumber: "+421232", calledNumber: "+421900" })).toBe("+421900");
  });
});

describe("call log rows", () => {
  it("carries the line label, partner, match and timings", () => {
    const row = callCenterCallFromActive(
      call({
        caseId: "case-1",
        match: {
          top: { id: "m1", type: "open_case", label: "Ján Novák", caseId: "case-1", confidence: "high" },
          count: 2,
          degraded: false,
        },
      }),
      { now: NOW, operatorName: (id) => (id === ME ? "Ja" : undefined), caseNumber: () => "PM-2026-0001" },
    );

    expect(row.id).toBe("call-row-1");
    expect(row.providerSessionId).toBe("sess-1");
    expect(row.lineLabel).toBe("Allianz Assistance");
    expect(row.queueLabel).toBe("Allianz");
    expect(row.callerName).toBe("Ján Novák");
    expect(row.caseNumber).toBe("PM-2026-0001");
    expect(row.operatorName).toBe("Ja");
    // Wait is measured to the answer, the duration from it.
    expect(row.waitSeconds).toBe(20);
    expect(row.durationSeconds).toBe(280);
  });

  it("falls back to the session id until the call-log row exists", () => {
    expect(callCenterCallFromActive(call({ callId: null }), { now: NOW }).id).toBe("sess-1");
  });

  it("falls back to an explicit unknown line", () => {
    const row = callCenterCallFromActive(call({ lineLabel: null, partnerName: null }), { now: NOW });
    expect(row.lineLabel).toBe("Neznáma linka");
    expect(row.callerName).toBeUndefined();
  });

  it("keeps waiting rows out of the live list and vice versa", () => {
    const waiting = call({ sessionId: "sess-2", state: "waiting", answeredByProfileId: null, answeredAt: null });
    const snapshot = payload({ calls: [call(), waiting], waiting: [waiting] });
    expect(liveCallCenterCalls(snapshot, { now: NOW }).map((row) => row.providerSessionId)).toEqual(["sess-1"]);
    expect(waitingRoomCalls(snapshot, { now: NOW }).map((row) => row.providerSessionId)).toEqual(["sess-2"]);
  });

  it("replaces a history row with its live version instead of showing both", () => {
    const live = callCenterCallFromActive(call(), { now: NOW });
    const history = [{ ...live, status: "ended" as const }, { ...live, id: "older" }];
    const merged = mergeCallCenterCalls([live], history);
    expect(merged.map((row) => row.id)).toEqual(["call-row-1", "older"]);
    expect(merged[0].status).toBe("answered");
  });
});

describe("PhoneBar model", () => {
  it("separates my call, my offers and the waiting room", () => {
    const mine = call();
    const offer = call({
      sessionId: "sess-2",
      state: "ringing",
      answeredAt: null,
      answeredByProfileId: null,
      offeredProfileIds: [ME, COLLEAGUE],
      mine: true,
    });
    const other = call({ sessionId: "sess-3", answeredByProfileId: COLLEAGUE, mine: false });
    const waiting = call({ sessionId: "sess-4", state: "parked", answeredByProfileId: null, mine: false });

    const model = buildPhoneBarModel(payload({ calls: [mine, offer, other, waiting], waiting: [waiting] }));

    expect(model.active?.sessionId).toBe("sess-1");
    expect(model.active?.lineLabel).toBe("Allianz Assistance");
    expect(model.active?.mine).toBe(true);
    expect(model.offers.map((entry) => entry.sessionId)).toEqual(["sess-2"]);
    expect(model.offers[0].kind).toBe("offer");
    expect(model.waiting.map((entry) => entry.sessionId)).toEqual(["sess-4"]);
    expect(model.otherActiveCount).toBe(1);
    expect(model.ownPresenceStatus).toBe("on_call");
  });

  it("does not treat a parked call of mine as the active call", () => {
    const parked = call({ state: "parked", answeredByProfileId: ME });
    const model = buildPhoneBarModel(payload({ calls: [parked], waiting: [parked] }));
    expect(model.active).toBeNull();
    expect(model.waiting).toHaveLength(1);
  });

  it("runs the fast poll cadence while ringing, not only while talking", () => {
    const offer = call({ sessionId: "sess-2", state: "ringing", answeredByProfileId: null, offeredProfileIds: [ME] });
    const ringing = buildPhoneBarModel(payload({ calls: [offer] }));
    expect(pollActivityInput(ringing).hasBrowserCall).toBe(true);

    const quiet = buildPhoneBarModel(payload());
    expect(pollActivityInput(quiet)).toEqual({ hasBrowserCall: false, liveCallCount: 0 });
  });

  it("uses the answer time as the timer origin once answered", () => {
    const model = buildPhoneBarModel(payload({ calls: [call()] }));
    expect(model.active?.timerSince).toBe("2026-09-03T08:00:20.000Z");

    const ringing = buildPhoneBarModel(
      payload({ calls: [call({ answeredAt: null, answeredByProfileId: null, offeredProfileIds: [ME] })] }),
    );
    expect(ringing.offers[0].timerSince).toBe("2026-09-03T08:00:00.000Z");
  });
});
