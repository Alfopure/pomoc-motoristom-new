import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";
import type { WebphoneCallView } from "./telnyx-webphone";

/** A stale SDK invite cannot override a fresh snapshot showing no pending leg. */
export function matchesIncomingBrowserInvite(call: PhoneBarCall, browser: WebphoneCallView | null | undefined): boolean {
  if (!browser?.ringing || browser.sessionId && browser.sessionId !== call.sessionId) return false;
  const pendingIds = call.browserIncomingCallControlIds ?? [];
  if (browser.telnyxCallControlId && pendingIds.length) return pendingIds.includes(browser.telnyxCallControlId);
  if (!browser.telnyxCallControlId && browser.sessionId === call.sessionId && pendingIds.length) return true;
  // Older snapshots may lack leg intent details. A current queue offer still
  // proves this actor is ringing; never use this fallback for active sessions.
  if (call.kind !== "offer" || !call.offeredToMe) return false;
  if (browser.telnyxCallControlId && call.browserCallControlIds?.length) return call.browserCallControlIds.includes(browser.telnyxCallControlId);
  return browser.sessionId === call.sessionId;
}

/** Use fresh SDK + server state at execution, for both accepting and rejecting. */
export function matchesRequestedIncomingOffer(model: PhoneBarModel, sessionId: string, callControlId: string | null, browser: WebphoneCallView | null | undefined): boolean {
  const call = [...model.offers, ...model.teamCalls, ...(model.active ? [model.active] : [])].find(item => item.sessionId === sessionId);
  return Boolean(call && (!callControlId || browser?.telnyxCallControlId === callControlId) && matchesIncomingBrowserInvite(call, browser));
}

/** Exact currently ringing leg that can be put in the waiting room from this UI.
 * Browser offers require the SDK invite; a personal mobile can use its own
 * actor-scoped server leg even though the browser has no call to match. */
export function deferOfferCallControlId(call: PhoneBarCall, browser: WebphoneCallView | null | undefined): string | null {
  if (call.kind !== "offer" || call.direction !== "inbound" || call.state !== "ringing" || !call.offeredToMe) return null;
  if (matchesIncomingBrowserInvite(call, browser) && browser?.telnyxCallControlId) return browser.telnyxCallControlId;
  return call.browserIncomingCallControlIds?.find((id) => !call.browserCallControlIds?.includes(id)) ?? null;
}

/** A defer click must name the current actor-owned leg, including a personal mobile leg.
 * Browser legs also require the SDK to still show that exact ringing invite. */
export function matchesRequestedDeferOffer(model: PhoneBarModel, sessionId: string, callControlId: string, browser: WebphoneCallView | null | undefined): boolean {
  if (!callControlId) return false;
  const offer = model.offers.find((call) => call.sessionId === sessionId);
  if (!offer || offer.direction !== "inbound" || offer.state !== "ringing" || !offer.offeredToMe) return false;
  if (offer.browserCallControlIds?.includes(callControlId)) {
    return matchesRequestedIncomingOffer(model, sessionId, callControlId, browser);
  }
  return Boolean(offer.browserIncomingCallControlIds?.includes(callControlId));
}
