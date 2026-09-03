import { describe, expect, it } from "vitest";

import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";

import {
  callElapsedSeconds,
  formatCallTimer,
  isDtmfKey,
  partyBusyKey,
  phoneBarCapabilities,
  phoneBarStateLabel,
  phoneBarVisible,
  phoneTakeoverAvailable,
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
    participants: [],
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

  it("offers the takeover only for the two terminal registration statuses", () => {
    expect(phoneTakeoverAvailable("failed")).toBe(true);
    expect(phoneTakeoverAvailable("superseded")).toBe(true);
    for (const status of ["idle", "requesting_token", "connecting", "registered", "reconnecting", "not_configured"] as const) {
      expect(phoneTakeoverAvailable(status)).toBe(false);
    }
  });

  it("accepts only real DTMF keys", () => {
    expect(isDtmfKey("#")).toBe(true);
    expect(isDtmfKey("A")).toBe(false);
  });
});

describe("conference capabilities", () => {
  const party = { legId: "leg-party", kind: "party" as const, profileId: null, name: "+421 900 000 000", detail: null, answered: true, muted: false, supervisorMode: null, self: false, controllable: true };

  it("offers adding a participant on a live or held call, but not while degraded", () => {
    expect(phoneBarCapabilities({ call: call({ state: "talking" }), browserCallActive: true, browserCallRinging: false }).addParty).toBe(true);
    expect(phoneBarCapabilities({ call: call({ state: "held" }), browserCallActive: true, browserCallRinging: false }).addParty).toBe(true);
    expect(phoneBarCapabilities({ call: call({ state: "talking" }), browserCallActive: true, browserCallRinging: false, degraded: true }).addParty).toBe(false);
    expect(phoneBarCapabilities({ call: call({ state: "talking", answered: false }), browserCallActive: true, browserCallRinging: false }).addParty).toBe(false);
    expect(phoneBarCapabilities({ call: call({ kind: "waiting" }), browserCallActive: false, browserCallRinging: false }).addParty).toBe(false);
  });

  it("offers leaving only once another participant is actually in the conference", () => {
    expect(phoneBarCapabilities({ call: call({ state: "conference", participants: [party] }), browserCallActive: true, browserCallRinging: false }).leaveConference).toBe(true);
    expect(phoneBarCapabilities({ call: call({ state: "conference", participants: [{ ...party, answered: false }] }), browserCallActive: true, browserCallRinging: false }).leaveConference).toBe(false);
    expect(phoneBarCapabilities({ call: call({ state: "talking", participants: [party] }), browserCallActive: true, browserCallRinging: false }).leaveConference).toBe(false);
  });

  it("narrows the two-party controls while a three-way is running", () => {
    const three = call({ state: "conference", participants: [party] });
    expect(phoneBarCapabilities({ call: three, browserCallActive: true, browserCallRinging: false })).toMatchObject({
      hold: false,
      park: false,
      transfer: false,
      consult: false,
      addParty: true,
      leaveConference: true,
      hangup: true,
    });
  });

  it("names the conference actions in Slovak", () => {
    expect(PHONE_ACTION_LABELS["add-party"]).toBe("Pridať účastníka");
    expect(PHONE_ACTION_LABELS.leave).toBe("Odísť z hovoru");
  });

  it("keys a participant command by action, call and leg", () => {
    // The hook sets this key and the bar compares against it: two participants
    // of the same call must not share a spinner.
    expect(partyBusyKey("mute", "sess-1", "leg-a")).toBe("mute:sess-1:leg-a");
    expect(partyBusyKey("kick", "sess-1", "leg-a")).not.toBe(partyBusyKey("kick", "sess-1", "leg-b"));
  });
});
