import { describe, expect, it } from "vitest";

import type { PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";

import { liveCallOperatorLabel, liveCallOverviewCounts } from "./LiveCallOverview";

function call(overrides: Partial<PhoneBarCall> = {}): PhoneBarCall {
  return {
    sessionId: "session-1",
    callId: null,
    kind: "active",
    state: "talking",
    direction: "inbound",
    lineLabel: "Linka pomoci",
    partnerName: null,
    number: "+421905123456",
    callerName: null,
    caseId: null,
    match: null,
    matchCount: 0,
    timerSince: "2026-09-04T12:00:00.000Z",
    answered: true,
    held: false,
    parked: false,
    consulting: false,
    conference: false,
    mine: false,
    operatorProfileId: null,
    operatorName: null,
    offeredProfileIds: [],
    offeredOperatorNames: [],
    offeredToMe: false,
    participants: [],
    ...overrides,
  };
}

function presence(profileId: string, state: TelephonyOperatorPresence["state"]): TelephonyOperatorPresence {
  return {
    profileId,
    operatorName: profileId,
    extensions: [],
    state,
    available: state === "available",
    queueMember: true,
    queueNumbers: [],
    availableQueues: [],
    paused: state === "paused",
    inUse: state === "ringing" || state === "on_call",
    registered: state !== "offline",
    detail: "",
  };
}

function model(teamCalls: PhoneBarCall[]): PhoneBarModel {
  return {
    checkedAt: "2026-09-04T12:00:00.000Z",
    configured: true,
    active: null,
    offers: [],
    waiting: [],
    otherActiveCount: 0,
    others: [],
    teamCalls,
    supervising: null,
    presence: { actorProfileId: "me", canManageAssignments: true, checkedAt: "", devices: [], presence: [] },
    ownPresenceStatus: "available",
  };
}

describe("liveCallOverviewCounts", () => {
  it("counts each live state and separates online, calling and paused operators", () => {
    const calls = [
      call({ sessionId: "ring", kind: "offer", state: "ringing", answered: false }),
      call({ sessionId: "wait", kind: "waiting", state: "waiting", answered: false }),
      call({ sessionId: "active", kind: "active", state: "talking" }),
    ];
    const operators = [
      presence("available", "available"),
      presence("ringing", "ringing"),
      presence("calling", "on_call"),
      presence("paused", "paused"),
      presence("offline", "offline"),
    ];

    expect(liveCallOverviewCounts(model(calls), operators)).toEqual({
      total: 3,
      ringing: 1,
      waiting: 1,
      active: 1,
      onlineOperators: 3,
      pausedOperators: 1,
      callingOperators: 1,
    });
  });
});

describe("liveCallOperatorLabel", () => {
  it("prefers the owning operator, then an answered external phone, then ringing operators", () => {
    expect(liveCallOperatorLabel(call({ operatorName: "Mango" }))).toBe("Mango");
    expect(liveCallOperatorLabel(call({
      participants: [{
        legId: "external-leg",
        kind: "operator",
        profileId: null,
        name: "+421 905 111 222",
        detail: null,
        answered: true,
        muted: false,
        supervisorMode: null,
        self: false,
        controllable: false,
      }],
    }))).toBe("Externý telefón: +421 905 111 222");
    expect(liveCallOperatorLabel(call({ kind: "offer", state: "ringing", answered: false, offeredOperatorNames: ["Lenka", "Peter"] }))).toBe("Zvoní: Lenka, Peter");
  });
});
