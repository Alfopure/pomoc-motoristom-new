import type { PhoneBarCall } from "./active-calls-model";
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
