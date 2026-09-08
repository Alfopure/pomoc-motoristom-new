import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";

/** Recover only this actor's own ring reservation, never another live call. */
export function canPickUpWithCurrentPresence(model: Pick<PhoneBarModel, "ownPresenceStatus" | "presence" | "pausedPickupEnabled">, call: Pick<PhoneBarCall, "sessionId" | "offeredToMe">): boolean {
  if (model.ownPresenceStatus === "available" || (model.ownPresenceStatus === "paused" && model.pausedPickupEnabled === true)) return true;
  if (model.ownPresenceStatus !== "ringing" || !call.offeredToMe) return false;
  const own = model.presence.presence.find((presence) => presence.profileId === model.presence.actorProfileId);
  return own?.status === "ringing" && own.currentSessionId === call.sessionId;
}
