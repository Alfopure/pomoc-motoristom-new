import { describe, expect, it } from "vitest";

import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";

import {
  callElapsedSeconds,
  formatCallTimer,
  isDtmfKey,
  phoneBarCapabilities,
  phoneBarStateLabel,
  phoneBarVisible,
  PHONE_ACTION_LABELS,
} from "./phone-bar-model";

function call(overrides: Partial<PhoneBarCall> = {}): PhoneBarCall {
  return {
    sessionId: "sess-1",
    callId: "call-1",
    kind: "active",
    state: "talking",
    direction: "inbound",
    lineLabel: "Allianz Assistance",
    partnerName: "Allianz",
    number: "+421900111222",
    callerName: null,
    caseId: null,
    match: null,
    matchCount: 0,
    timerSince: "2026-09-03T08:00:00.000Z",
    answered: true,
    held: false,
    parked: false,
    consulting: false,
    conference: false,
    mine: true,
    ...overrides,
  };
}

describe("phone bar capabilities", () => {
  it("offers hold, transfer, consult and park on a live call", () => {
    const capabilities = phoneBarCapabilities({ call: call(), browserCallActive: true, browserCallRinging: false });
    expect(capabilities).toMatchObject({
      hangup: true,
      hold: true,
      unhold: false,
      park: true,
      transfer: true,
      consult: true,
      mute: true,
      dtmf: true,
    });
  });

  it("refuses conference-backed actions once promotion failed, but keeps the call controllable", () => {
    const capabilities = phoneBarCapabilities({ call: call(), browserCallActive: true, browserCallRinging: false, degraded: true });
    expect(capabilities.hold).toBe(false);
    expect(capabilities.consult).toBe(false);
    expect(capabilities.transfer).toBe(true);
    expect(capabilities.hangup).toBe(true);
  });

  it("swaps hold for unhold while the customer is on music", () => {
    const capabilities = phoneBarCapabilities({ call: call({ state: "held", held: true }), browserCallActive: true, browserCallRinging: false });
    expect(capabilities.hold).toBe(false);
    expect(capabilities.unhold).toBe(true);
    expect(capabilities.transfer).toBe(true);
  });

  it("offers only completing or cancelling during a consultation", () => {
    const capabilities = phoneBarCapabilities({ call: call({ state: "consulting", consulting: true }), browserCallActive: true, browserCallRinging: false });
    expect(capabilities.completeTransfer).toBe(true);
    expect(capabilities.cancelConsult).toBe(true);
    expect(capabilities.hold).toBe(false);
  });

  it("answers an offer only when the browser really has the invite", () => {
    const offer = call({ kind: "offer", state: "ringing", answered: false, mine: false });
    expect(phoneBarCapabilities({ call: offer, browserCallActive: false, browserCallRinging: false }).answer).toBe(false);
    expect(phoneBarCapabilities({ call: offer, browserCallActive: false, browserCallRinging: true }).answer).toBe(true);
  });

  it("only allows pickup on a waiting-room row", () => {
    const capabilities = phoneBarCapabilities({ call: call({ kind: "waiting", state: "parked", parked: true }), browserCallActive: false, browserCallRinging: false });
    expect(capabilities.pickup).toBe(true);
    expect(capabilities.hangup).toBe(false);
    expect(capabilities.hold).toBe(false);
  });

  it("still allows hanging up an invite the server does not know about yet", () => {
    const capabilities = phoneBarCapabilities({ call: null, browserCallActive: false, browserCallRinging: true });
    expect(capabilities.answer).toBe(true);
    expect(capabilities.hangup).toBe(true);
  });
});

describe("presentation helpers", () => {
  it("formats the timer with hours only when needed", () => {
    expect(formatCallTimer(0)).toBe("00:00");
    expect(formatCallTimer(65)).toBe("01:05");
    expect(formatCallTimer(3_725)).toBe("1:02:05");
    expect(formatCallTimer(-5)).toBe("00:00");
  });

  it("counts from the timer origin and tolerates a broken timestamp", () => {
    expect(callElapsedSeconds({ timerSince: "2026-09-03T08:00:00.000Z" }, Date.parse("2026-09-03T08:01:30.000Z"))).toBe(90);
    expect(callElapsedSeconds({ timerSince: "nonsense" }, Date.now())).toBe(0);
  });

  it("labels every call state in Slovak", () => {
    expect(phoneBarStateLabel(call()).label).toBe("Prebieha");
    expect(phoneBarStateLabel(call({ state: "held" })).tone).toBe("hold");
    expect(phoneBarStateLabel(call({ kind: "offer" })).label).toBe("Zvoní");
    expect(phoneBarStateLabel(call({ kind: "waiting", parked: true })).label).toBe("V čakárni");
    expect(phoneBarStateLabel(call({ state: "ringing", direction: "outbound" })).label).toBe("Vytáčam");
    expect(PHONE_ACTION_LABELS.hold).toBe("Podržať");
  });

  it("hides the bar without a provider and shows it whenever something is happening", () => {
    expect(phoneBarVisible({ status: "not_configured", hasCall: true, hasOffer: true, hasWaiting: true })).toBe(false);
    expect(phoneBarVisible({ status: "idle", hasCall: false, hasOffer: false, hasWaiting: false })).toBe(false);
    expect(phoneBarVisible({ status: "idle", hasCall: false, hasOffer: false, hasWaiting: true })).toBe(true);
    expect(phoneBarVisible({ status: "registered", hasCall: false, hasOffer: false, hasWaiting: false })).toBe(true);
  });

  it("accepts only real DTMF keys", () => {
    expect(isDtmfKey("#")).toBe(true);
    expect(isDtmfKey("A")).toBe(false);
  });
});
