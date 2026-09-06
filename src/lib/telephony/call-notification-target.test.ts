import { describe, expect, it } from "vitest";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS, type PhoneBarCall } from "./active-calls-model";
import { callNotificationTarget } from "./call-notification-target";
import type { WebphoneSnapshot } from "./telnyx-webphone";

const sessionId = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";
const call: PhoneBarCall = {
  sessionId, callId: null, browserCallControlIds: ["own-operator-leg"], kind: "waiting", state: "waiting", direction: "inbound",
  lineLabel: "Linka pomoci", partnerName: null, number: "+421900000001", callerName: null, caseId: null, match: null, matchCount: 0,
  timerSince: "2026-09-06T10:00:00Z", answered: false, held: false, parked: false, consulting: false, conference: false, mine: false,
  operatorProfileId: null, operatorName: null, offeredProfileIds: [], offeredOperatorNames: [], offeredToMe: false, participants: [],
};
const phone: WebphoneSnapshot = {
  status: "registered", registration: { status: "registered", label: "Pripojené", detail: "", tone: "ok" },
  sipUsername: null, deviceSessionId: null, call: null, message: null,
};
const input = {
  focus: { sessionId, snapshotAtOpen: "old-snapshot" },
  model: { ...buildPhoneBarModel(EMPTY_ACTIVE_CALLS), checkedAt: "fresh-snapshot", ownPresenceStatus: "available" as const, teamCalls: [call] },
  phone, configured: true, stale: false, busy: false, outboundPending: false,
};
const ringing = {
  id: "browser-call", state: "ringing", direction: "inbound" as const, number: call.number, callerName: null,
  telnyxCallControlId: "own-operator-leg", sessionId: null, muted: false, ringing: true, active: false,
};

describe("call notification current state", () => {
  it("waits for a refreshed snapshot and refuses stale or unavailable state", () => {
    for (const result of [
      callNotificationTarget({ ...input, model: { ...input.model, checkedAt: "old-snapshot" } }),
      callNotificationTarget({ ...input, stale: true }),
      callNotificationTarget({ ...input, configured: false }),
    ]) {
      expect(result).toMatchObject({ canAnswer: false, canPickup: false, call: null });
    }
  });

  it("offers explicit pickup only for the exact waiting session and an available empty phone", () => {
    expect(callNotificationTarget(input)).toMatchObject({ call, canPickup: true, canAnswer: false });
    for (const overrides of [
      { busy: true }, { outboundPending: true }, { phone: { ...phone, call: ringing } },
      { model: { ...input.model, active: call } }, { model: { ...input.model, ownPresenceStatus: "paused" as const } },
      { phone: { ...phone, status: "connecting" as const } },
    ]) expect(callNotificationTarget({ ...input, ...overrides }).canPickup).toBe(false);
  });

  it("never answers another browser call, even if the caller number is identical", () => {
    const model = { ...input.model, teamCalls: [{ ...call, kind: "offer" as const, state: "ringing" as const, offeredToMe: true }] };
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: ringing } }).canAnswer).toBe(true);
    const different = { ...ringing, telnyxCallControlId: "another-operator-leg", sessionId: "another-session" };
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: different } }).canAnswer).toBe(false);
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: { ...ringing, sessionId: "conflicting-session" } } }).canAnswer).toBe(false);
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: ringing, answering: true } }).canAnswer).toBe(false);
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: null } }).canAnswer).toBe(false);
  });

  it("uses an exact session identity when an accepted pickup has already correlated the browser", () => {
    const model = { ...input.model, teamCalls: [{ ...call, kind: "offer" as const, offeredToMe: true, browserCallControlIds: undefined }] };
    expect(callNotificationTarget({ ...input, model, phone: { ...phone, call: { ...ringing, sessionId } } }).canAnswer).toBe(true);
  });

  it("reports a taken or missing call without offering pickup or a different caller", () => {
    const taken = callNotificationTarget({ ...input, model: { ...input.model, teamCalls: [{ ...call, kind: "active", operatorName: "Jana" }] } });
    expect(taken.message).toContain("vybavuje Jana");
    expect(taken).toMatchObject({ canPickup: false, canAnswer: false });
    const missing = callNotificationTarget({ ...input, model: { ...input.model, teamCalls: [{ ...call, sessionId: "other-session" }] } });
    expect(missing.message).toContain("už nie je dostupný");
    expect(missing).toMatchObject({ call: null, canPickup: false, canAnswer: false });
  });

  it("offers reconnection only for a live target with no conflicting browser call", () => {
    expect(callNotificationTarget({ ...input, phone: { ...phone, status: "superseded" } })).toMatchObject({ canReconnect: true, canPickup: false });
    expect(callNotificationTarget({ ...input, phone: { ...phone, status: "superseded", call: ringing } }).canReconnect).toBe(false);
    expect(callNotificationTarget({ ...input, model: { ...input.model, teamCalls: [] }, phone: { ...phone, status: "superseded" } }).canReconnect).toBe(false);
  });
});
