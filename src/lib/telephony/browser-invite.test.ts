import { expect, it } from "vitest";
import { matchesRequestedIncomingOffer } from "./browser-invite";
import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";
import type { WebphoneCallView } from "./telnyx-webphone";
const offer = (sessionId: string, leg: string) => ({ sessionId, kind: "offer", offeredToMe: true, browserIncomingCallControlIds: [leg] } as PhoneBarCall);
const model = (calls: PhoneBarCall[]) => ({ offers: calls, teamCalls: [], active: null } as unknown as PhoneBarModel);
const browser = (sessionId: string, leg: string) => ({ sessionId, telnyxCallControlId: leg, ringing: true } as WebphoneCallView);
it("blocks stale A accept/reject after SDK switched to B without a React render", () => {
  const latest = model([offer("A", "leg-a"), offer("B", "leg-b")]);
  expect(matchesRequestedIncomingOffer(latest, "A", "leg-a", browser("B", "leg-b"))).toBe(false);
  expect(matchesRequestedIncomingOffer(latest, "B", "leg-b", browser("B", "leg-b"))).toBe(true);
});
it("blocks a replaced leg or offer already removed by a colleague", () => {
  expect(matchesRequestedIncomingOffer(model([offer("A", "new")]), "A", "old", browser("A", "new"))).toBe(false);
  expect(matchesRequestedIncomingOffer(model([]), "A", "old", browser("A", "old"))).toBe(false);
  expect(matchesRequestedIncomingOffer(model([offer("A", "old")]), "A", "old", { ...browser("A", "old"), ringing: false })).toBe(false);
});
