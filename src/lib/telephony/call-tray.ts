import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";

/** Only an actual ringing leg belongs in the personal offer tray, never IVR. */
export function isTrayOffer(call: PhoneBarCall): boolean {
  return call.kind === "offer" && call.state === "ringing" && !call.operatorProfileId;
}

export function callTrayOffers(model: PhoneBarModel): PhoneBarCall[] {
  const calls = new Map<string, PhoneBarCall>();
  // Keep enriched actor matches when the shared snapshot contains the same id.
  for (const call of [...model.teamCalls, ...model.offers]) {
    if (isTrayOffer(call) && call.sessionId !== model.active?.sessionId) calls.set(call.sessionId, call);
  }
  return [...calls.values()].sort((a, b) => {
    const left = Date.parse(a.startedAt ?? a.timerSince) || 0;
    const right = Date.parse(b.startedAt ?? b.timerSince) || 0;
    return left - right || a.sessionId.localeCompare(b.sessionId);
  });
}

/** The pinned media row counts towards the three visible rows. */
export function callTrayCapacity(hasPinned: boolean): number { return hasPinned ? 2 : 3; }
