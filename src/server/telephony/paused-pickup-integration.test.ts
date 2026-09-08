import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer, completeTransfer, hangupCall, parkCall, pickupWaitingCall, startConsult } from "./call-actions";
import { runPendingEffectRecovery } from "./cron-jobs";
import { reserveOperatorPickup } from "./routing/reservation";
import { endWrapUp, setPresence, sweepExpiredWrapUp } from "./presence-service";
import { authorizeOperatorDispatch, releaseOperator, reserveOperatorOwnership, transitionPresence } from "./routing/reservation";
import { effectivePresenceStatus, effectivePresenceSince } from "@/lib/telephony/presence-policy";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const own = { organizationId: ORG, profileId: actor.profileId };
const REASON = "00000000-0000-4000-8000-000000002501";
afterEach(() => vi.unstubAllEnvs());

async function pausedPickup(wrapUpSeconds = 30) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness();
  for (const profileId of Object.values(PROFILES)) h.setPresence(profileId, { status: "offline" });
  await h.admin.from("motorist_operator_telephony_settings").update({ wrap_up_seconds: wrapUpSeconds }).eq("profile_id", actor.profileId);
  await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: REASON });
  const call = await h.inbound({ to: NUMBERS.allianz });
  expect(h.legByNumber(call.sessionId, NUMBERS.external)).toBeTruthy();
  return { h, call };
}

describe("paused pickup through staged session pipeline", () => {
  it("PU-05 restores original pause after dial failure and keeps customer/backup alive", async () => {
    const { h, call } = await pausedPickup();
    h.telnyx.failNext("dial", "pickup unavailable");
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: REASON, current_session_id: null });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", ended_at: null });
    expect(h.telnyx.of("hangup").map(x => x.params.callControlId)).not.toContain(call.callControlId);
  });

  it("PU-03 repeated explicit pickup returns the same leg before and after answer", async () => {
    const { h, call } = await pausedPickup();
    const first = await pickupWaitingCall(h.deps, actor, call.sessionId);
    const count = h.telnyx.of("dial").length;
    expect(await pickupWaitingCall(h.deps, actor, call.sessionId)).toMatchObject({ operatorLegCallControlId: first.operatorLegCallControlId, ignored: "pickup_in_progress" });
    await h.legEvent(first.operatorLegCallControlId!, "call.answered");
    expect(await pickupWaitingCall(h.deps, actor, call.sessionId)).toMatchObject({ operatorLegCallControlId: first.operatorLegCallControlId, ignored: "pickup_in_progress" });
    expect(h.telnyx.of("dial")).toHaveLength(count);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it.each(["hangup", "park", "blind_transfer", "attended_transfer"])("PU-06 restores paused reason after %s and expired wrap-up before sweep", async exit => {
    const { h, call } = await pausedPickup();
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    expect(picked.operatorLegCallControlId).toBeTruthy();
    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");
    expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", pause_return: { pauseReasonId: REASON } });
    if (exit === "hangup") await hangupCall(h.deps, actor, call.sessionId);
    else if (exit === "park") await completeAnnouncedAction(h, parkCall(h.deps, actor, call.sessionId));
    else if (exit === "blind_transfer") await completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, { number: NUMBERS.external }));
    else {
      await completeAnnouncedAction(h, startConsult(h.deps, actor, call.sessionId, { number: NUMBERS.external }));
      const consult = h.legs(call.sessionId).find(leg => leg.role === "consult")!;
      await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
      await completeAnnouncedAction(h, completeTransfer(h.deps, actor, call.sessionId));
    }
    expect(h.presence(actor.profileId)).toMatchObject({ status: "after_call_work", current_session_id: null, pause_return: { pauseReasonId: REASON } });
    h.advance(31_000);
    const presence = h.presence(actor.profileId);
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until: presence.wrap_up_until as string, pause_return: presence.pause_return }, h.now())).toBe("paused");
    const other = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "waiting" })[0];
    expect((await authorizeOperatorDispatch(h.admin, { ...own, sessionId: String(other.id) })).applied).toBe(false);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    expect(await endWrapUp(h.deps, own)).toMatchObject({ status: "paused", pause_reason_id: REASON, pause_return: null });
  });

  it("PU-06/08 materializes expired return without a console and starts pause at wrap-up expiry", async () => {
    const { h, call } = await pausedPickup();
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");
    await hangupCall(h.deps, actor, call.sessionId);
    const until = String(h.presence(actor.profileId).wrap_up_until);
    expect(await sweepExpiredWrapUp(h.deps)).toMatchObject({ checked: 0, applied: 0 });
    h.advance(150_000);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const pending = h.presence(actor.profileId);
    expect(effectivePresenceSince({ status: "after_call_work", status_since: String(pending.status_since), wrap_up_until: until, pause_return: pending.pause_return }, h.now())).toBe(until);
    expect(await sweepExpiredWrapUp(h.deps)).toMatchObject({ checked: 1, applied: 1, errors: [] });
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: REASON, status_since: until, pause_return: null });
    expect(h.rows("motorist_operator_statuses").filter(r => r.profile_id === actor.profileId).at(-1)).toMatchObject({ status: "paused", started_at: until, reason: "Obed" });
    expect(await sweepExpiredWrapUp(h.deps)).toMatchObject({ checked: 0, applied: 0 });
  });

  it("PU-06 zero wrap-up never exposes available", async () => {
    const { h, call } = await pausedPickup(0);
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");
    await hangupCall(h.deps, actor, call.sessionId);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: REASON, current_session_id: null, pause_return: null });
  });

  it("PU-05 expires a committed pickup claim when the process stopped before dial", async () => {
    const { h, call } = await pausedPickup();
    const claim = await reserveOperatorPickup(h.admin, { ...own, sessionId: call.sessionId });
    expect(claim.applied).toBe(true);
    h.advance(61_000);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    expect(await runPendingEffectRecovery(h.deps)).toMatchObject({ status: "ok", detail: { checked: 1 } });
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: REASON, current_session_id: null });
    expect(h.session(call.sessionId)).toMatchObject({ presence_pickup: null });
    expect(h.session(call.sessionId).presence_cancellations).toHaveProperty(claim.offerToken!);
  });

  it("rejects compensation with the original acquired token after same-session reacquisition", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    const session = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "waiting" })[0];
    const sessionId = String(session.id);
    const first = await reserveOperatorOwnership(h.admin, { ...own, sessionId });
    expect(first.applied).toBe(true);
    await transitionPresence(h.admin, { ...own, sessionId, action: "release", status: "available", expectedToken: first.offerToken });
    const next = await reserveOperatorOwnership(h.admin, { ...own, sessionId });
    expect(next.offerToken).not.toBe(first.offerToken);
    expect(await releaseOperator(h.admin, { ...own, sessionId, status: "available", expectedToken: first.offerToken!, expectedRevision: first.revision })).toBe(false);
    expect(await releaseOperator(h.admin, { ...own, sessionId, status: "available" })).toBe(false);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", offer_token: next.offerToken, presence_revision: next.revision });
  });
});
