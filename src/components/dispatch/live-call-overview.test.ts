import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";
import type { WebphoneCallView, WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

import { HeaderLiveCallsMenu, LiveCallsWorkspace, liveBrowserInviteSessionId, liveCallOperatorLabel, liveCallOverviewCounts } from "./LiveCallOverview";

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

  it("shows the external ringing destination after the browser offer times out", () => {
    expect(liveCallOperatorLabel(call({ kind: "offer", state: "ringing", answered: false, participants: [{
      legId: "backup", kind: "operator", profileId: null, name: "+421 900 000 003", detail: null,
      answered: false, muted: false, supervisorMode: null, self: false, controllable: false,
    }] }))).toBe("Zvoní na externom telefóne: +421 900 000 003");
  });
});

describe("live call invite actions", () => {
  const offers = [
    call({ sessionId: "first-session", callerName: "Prvý volajúci", kind: "offer", state: "ringing", offeredToMe: true }),
    call({ sessionId: "second-session", callerName: "Druhý volajúci", kind: "offer", state: "ringing", offeredToMe: true }),
  ];
  const common = {
    model: { ...model(offers), offers }, presences: [], canManageCalls: false, busyAction: null, phone: null,
    onAnswer() {}, onRejectOffer() {}, onCallAction() {}, onSupervise() {}, onStopSupervise() {}, onNewCase() {}, onOpenCase() {},
  };
  const browser: WebphoneCallView = {
    id: "callee-browser-leg", state: "ringing", direction: "inbound", number: offers[0].number, callerName: null,
    telnyxCallControlId: "callee-control-id", sessionId: null, muted: false, active: false, ringing: true,
  };
  function phone(call: WebphoneCallView | null = browser): WebphoneSnapshot {
    return { status: "registered", registration: { status: "registered", label: "Pripojené", detail: "", tone: "ok" }, call, message: null, sipUsername: null, deviceSessionId: null };
  }
  for (const component of [HeaderLiveCallsMenu, LiveCallsWorkspace]) {
    it(`${component.name} only answers/rejects the correlated second invite`, () => {
      const html = renderToStaticMarkup(createElement(component, { ...common, phone: phone({ ...browser, sessionId: "second-session" }) }));
      const rows = html.match(/<article\b[\s\S]*?<\/article>/g)!;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("Prvý volajúci");
      expect(rows[0]).not.toContain("Prijať");
      expect(rows[0]).not.toContain("Odmietnuť");
      expect(rows[1]).toContain("Druhý volajúci");
      expect(rows[1]).toContain("Prijať");
      expect(rows[1]).toContain("Odmietnuť");
    });

    it(`${component.name} waits for correlation instead of guessing from an offered row`, () => {
      const html = renderToStaticMarkup(createElement(component, { ...common, phone: phone({ ...browser, telnyxCallControlId: null }) }));
      expect(html).not.toContain("Prijať");
      expect(html).not.toContain("Odmietnuť");
    });

    it.each([
      { kind: "offer", state: "ringing", direction: "internal" },
      { kind: "active", state: "consulting", direction: "inbound" },
      { kind: "active", state: "conference", direction: "inbound" },
    ] as const)(`${component.name} accepts only the exact $state callee without a queue offer`, (state) => {
      const teamCalls = [offers[0], { ...offers[1], ...state, offeredToMe: false, browserCallControlIds: ["callee-control-id"], browserIncomingCallControlIds: ["callee-control-id"] }];
      const snapshot = model(teamCalls);
      const session = liveBrowserInviteSessionId(snapshot, browser);
      expect(session).toBe("second-session");
      const html = renderToStaticMarkup(createElement(component, { ...common, model: snapshot, phone: phone() }));
      const rows = html.match(/<article\b[\s\S]*?<\/article>/g)!;
      expect(rows[0]).not.toContain("Prijať");
      expect(rows[0]).not.toContain("Odmietnuť");
      expect(rows[1]).toContain("Prijať");
      expect(rows[1]).toContain("Odmietnuť");

      const mismatch = liveBrowserInviteSessionId(snapshot, { ...browser, sessionId: "conflicting-session" });
      expect(mismatch).toBeNull();
      const unmatched = renderToStaticMarkup(createElement(component, { ...common, model: snapshot, phone: phone({ ...browser, sessionId: "conflicting-session" }) }));
      expect(unmatched).not.toContain("Prijať");
      expect(unmatched).not.toContain("Odmietnuť");
    });

    it(`${component.name} cannot answer a cancelled invite after a colleague wins the same session`, () => {
      const snapshot = model([{ ...offers[1], kind: "active", state: "talking", offeredToMe: false, browserCallControlIds: ["callee-control-id"], browserIncomingCallControlIds: [] }]);
      const session = liveBrowserInviteSessionId(snapshot, { ...browser, sessionId: "second-session" });
      expect(session).toBeNull();
      const html = renderToStaticMarkup(createElement(component, { ...common, model: snapshot, phone: phone({ ...browser, sessionId: "second-session" }) }));
      expect(html).not.toContain("Prijať");
      expect(html).not.toContain("Odmietnuť");
    });

    it(`${component.name} recovers its own offered session but blocks a different reservation or pending leg`, () => {
      const incoming = call({ kind: "offer", state: "ringing", answered: false, offeredToMe: true });
      const snapshot = {
        ...model([incoming]), ownPresenceStatus: "ringing" as const,
        presence: { ...model([]).presence, presence: [{ profileId: "me", status: "ringing" as const, currentSessionId: incoming.sessionId }] },
      };
      const html = renderToStaticMarkup(createElement(component, { ...common, model: snapshot, phone: phone(null) }));
      expect(html.match(/<button\b[^>]*title="Prevziať"[^>]*>/)?.[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
      expect(html).toContain('title="Prevziať"');
      const other = { ...snapshot, presence: { ...snapshot.presence, presence: [{ profileId: "me", status: "ringing" as const, currentSessionId: "other-session" }] } };
      const blocked = renderToStaticMarkup(createElement(component, { ...common, model: other, phone: phone(null) }));
      expect(blocked).not.toContain('title="Prevziať"');
      expect(blocked).toContain('title="Čakám na zvonenie v tomto okne"');
      const pending = renderToStaticMarkup(createElement(component, { ...common, model: snapshot, phone: { ...phone(null), pendingOperatorLegs: 1 } }));
      expect(pending).toContain('title="Pripájanie hovoru…"');
      expect(pending).not.toContain('title="Prevziať"');
    });
  }

  it("does not match a non-ringing browser call or an unknown identity", () => {
    const snapshot = model([{ ...offers[0], browserCallControlIds: ["callee-control-id"] }]);
    expect(liveBrowserInviteSessionId(snapshot, { ...browser, ringing: false })).toBeNull();
    expect(liveBrowserInviteSessionId(snapshot, { ...browser, telnyxCallControlId: "unknown" })).toBeNull();
    expect(liveBrowserInviteSessionId(snapshot, { ...browser, sessionId: "first-session", telnyxCallControlId: null })).toBe("first-session");
  });
});
