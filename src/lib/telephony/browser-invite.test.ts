import { expect, it } from "vitest";
import { deferOfferCallControlId, matchesRequestedDeferOffer, matchesRequestedIncomingOffer } from "./browser-invite";
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

it("defers only the current exact browser offer, not a stale SDK invite", () => {
  const current = model([
    { ...offer("A", "leg-a"), direction: "inbound", state: "ringing", browserCallControlIds: ["leg-a"] },
    { ...offer("B", "leg-b"), direction: "inbound", state: "ringing", browserCallControlIds: ["leg-b"] },
  ]);
  expect(matchesRequestedDeferOffer(current, "A", "leg-a", browser("B", "leg-b"))).toBe(false);
  expect(matchesRequestedDeferOffer(current, "B", "leg-b", browser("B", "leg-b"))).toBe(true);
  expect(matchesRequestedDeferOffer(current, "B", "leg-b", { ...browser("B", "leg-b"), ringing: false })).toBe(false);
});

it("accepts the actor's exact ringing personal-mobile leg without a browser invite", () => {
  const mobile = model([{ ...offer("mobile", "mobile-leg"), direction: "inbound", state: "ringing", browserCallControlIds: [] }]);
  expect(deferOfferCallControlId(mobile.offers[0], null)).toBe("mobile-leg");
  expect(matchesRequestedDeferOffer(mobile, "mobile", "mobile-leg", null)).toBe(true);
  expect(matchesRequestedDeferOffer(mobile, "mobile", "old-leg", null)).toBe(false);
  expect(matchesRequestedDeferOffer(model([]), "mobile", "mobile-leg", null)).toBe(false);
  const noLongerOffered = model([{ ...offer("mobile", "mobile-leg"), direction: "inbound", state: "ringing", offeredToMe: false, browserCallControlIds: [] }]);
  expect(matchesRequestedDeferOffer(noLongerOffered, "mobile", "mobile-leg", null)).toBe(false);
});

it("does not display defer for a browser leg until that exact SDK invite is ringing", () => {
  const web: PhoneBarCall = { ...offer("web", "web-leg"), direction: "inbound", state: "ringing", browserCallControlIds: ["web-leg"] };
  expect(deferOfferCallControlId(web, null)).toBeNull();
  expect(deferOfferCallControlId(web, browser("web", "web-leg"))).toBe("web-leg");
  expect(deferOfferCallControlId(web, browser("other", "other-leg"))).toBeNull();
});
