import { SessionLeaseLostError } from "../service-errors";
import { commandId } from "../telnyx/command-id";
import { isCallGoneError, TELNYX_CALL_ENDED_CODE } from "../telnyx/client";
import type { TelnyxClientState } from "../telnyx/client-state";
import { providerEndedLegs } from "../termination";
import type { EffectsDeps } from "./effects";
import type { SessionRow } from "./types";

type Cancellation = { profileId: string; requestedAt: string; reason: string };

/** The tombstone survives a successful hangup: a late, previously unknown leg can still arrive. */
export async function cancelRevokedOffers(deps: EffectsDeps, input: SessionRow, arriving?: { callControlId: string; clientState: TelnyxClientState; dialed?: boolean }): Promise<{ cancelled: number; pending: number }> {
  // The tombstones and the legs they point at are independent reads, and this
  // pass stands between an operator's click and the command it issues. The
  // session read stays fresh — a tombstone written while a dial was in flight
  // is exactly what this exists to catch — but it no longer waits for the legs
  // to be asked for afterwards.
  const [fresh, legs] = await Promise.all([
    deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", input.id).single(),
    deps.admin.from("motorist_call_legs").select("*").eq("organization_id", deps.organizationId).eq("session_id", input.id),
  ]);
  if (fresh.error) throw new Error(`Offer cancellation read failed: ${fresh.error.message}`);
  const session = fresh.data;
  const cancellations = session.presence_cancellations as Record<string, Cancellation> | undefined;
  if (!cancellations || !Object.keys(cancellations).length) return { cancelled: 0, pending: 0 };
  if (legs.error) throw new Error(`Cancelled offer legs unavailable: ${legs.error.message}`);
  let cancelled = 0, pending = 0;
  const targets: Array<{ token: string; live: Set<string> }> = [];
  for (const [token, cancellation] of Object.entries(cancellations)) {
    const matches = (state: TelnyxClientState | null, profileId: string | null) => profileId === cancellation.profileId &&
      (state?.offerToken === token || token === `legacy:${profileId}` && !state?.offerToken);
    const owned = (legs.data ?? []).filter((leg) => matches(leg.client_state as TelnyxClientState | null, leg.profile_id));
    const live = new Set(owned.filter((leg) => !leg.ended_at).map((leg) => leg.telnyx_call_control_id));
    if (arriving && matches(arriving.clientState, arriving.clientState.operatorId ?? null)) live.add(arriving.callControlId);
    if (!owned.length && !live.size && !session.ended_at && deps.now().getTime() - Date.parse(cancellation.requestedAt) < 5 * 60_000) pending += 1;
    targets.push({ token, live });
  }
  // The revoking transition usually hung these legs up a moment ago, and their
  // `call.hangup` is not recorded on the leg yet. Another hangup would only
  // reach Telnyx as 90018 (call already ended). This invocation's own hangups
  // need no read; earlier ones use the provider evidence teardown relies on (an
  // accepted hangup or a received `call.hangup`). An unreadable read sends.
  // Behind our own dial the revoked leg was created a moment ago and must stop
  // ringing at once; that pass keeps the previous behaviour without the read.
  // Only our own accepted hangup counts here: a leg merely refused with 90018
  // still gets its cancellation hangup unless the provider evidence says it ended.
  const hungUpHere = (callControlId: string) => typeof deps.endedLegs?.get(callControlId) === "string";
  const unknown = arriving?.dialed ? [] : [...new Set(targets.flatMap(({ live }) => [...live]))].filter((callControlId) => !hungUpHere(callControlId));
  const providerEnded = unknown.length ? await providerEndedLegs(deps, session.id, unknown.map((callControlId) => ({ callControlId }))) : new Set<string>();
  for (const { token, live } of targets) {
    for (const callControlId of live) {
      if (hungUpHere(callControlId) || providerEnded.has(callControlId)) { cancelled += 1; continue; }
      try {
        if (!deps.telnyx) throw new Error("Provider unavailable for offer cancellation");
        const hangupId = commandId({ sessionId: session.id, legId: callControlId, step: token, intent: "cancel:offer" });
        await deps.telnyx.hangup({ callControlId, commandId: hangupId });
        deps.endedLegs?.set(callControlId, hangupId);
        cancelled += 1;
      } catch (error) {
        if (error instanceof SessionLeaseLostError) throw error;
        if (isCallGoneError(error)) {
          cancelled += 1;
          if (String(error.code) === TELNYX_CALL_ENDED_CODE && !deps.endedLegs?.has(callControlId)) deps.endedLegs?.set(callControlId, null);
        }
        else {
          pending += 1;
          deps.logger?.({ level: "warn", scope: "offers", sessionId: session.id, offerToken: token, code: "offer_cancel_pending" });
        }
      }
    }
  }
  // Nothing left waiting and nothing scheduled: the write would put null over
  // null. This pass runs in front of every control on a session that has ever
  // revoked an offer, so that is a round trip an operator waits for in
  // exchange for no change at all.
  if (pending === 0 && session.cancellations_next_attempt_at === null) return { cancelled, pending };
  // PostgREST sends filter values as text, so the jsonb compare-and-set needs the serialized value.
  const saved = await deps.admin.from("motorist_call_sessions").update({ cancellations_next_attempt_at: pending ? new Date(deps.now().getTime() + 30_000).toISOString() : null })
    .eq("organization_id", deps.organizationId).eq("id", session.id).eq("presence_cancellations", JSON.stringify(cancellations));
  if (saved.error) throw new Error(`Offer cancellation checkpoint failed: ${saved.error.message}`);
  return { cancelled, pending };
}
