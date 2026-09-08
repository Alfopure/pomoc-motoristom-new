import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createRateLimiter, hangupCall, parkCall, pickupWaitingCall } from "./call-actions";
import { runPendingEffectRecovery } from "./cron-jobs";
import { setPresence, sweepExpiredWrapUp } from "./presence-service";
import { materializeDuePauseEndingNotifications, materializePauseEndingNotification } from "./pause-ending-notifications";

const sendPauseEndingPush = vi.hoisted(() => vi.fn(async () => ({ sent: 1, failed: 0 })));
vi.mock("@/server/web-push", async importOriginal => {
  const actual = await importOriginal<typeof import("@/server/web-push")>();
  return { ...actual, sendPauseEndingPush };
});

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const own = { organizationId: ORG, profileId: actor.profileId };
const pauseReason = "00000000-0000-4000-8000-000000002501";
const actionDeps = (h: TelephonyHarness) => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
const history = (h: TelephonyHarness) => h.rows("motorist_operator_statuses").filter(row => row.profile_id === actor.profileId);
beforeEach(() => { vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true"); sendPauseEndingPush.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function pause(h: TelephonyHarness) {
  await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: pauseReason });
}
async function answer(h: TelephonyHarness, cc: string) {
  h.telnyx.physical.answered(cc);
  await h.legEvent(cc, "call.answered");
  const leg = h.rows("motorist_call_legs").find(row => row.telnyx_call_control_id === cc)!;
  await completeCallAnnouncements(h, String(leg.session_id));
}
async function waitingWithPausedOperator() {
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  for (const profile of Object.values(PROFILES)) h.setPresence(profile, { status: "offline" });
  await pause(h);
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const backup = String(h.legByNumber(call.sessionId, NUMBERS.external)!.telnyx_call_control_id);
  return { h, call, backup };
}
function assertReturnedPause(h: TelephonyHarness, sessionId: string) {
  expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null, pause_return: null });
  expect(h.session(sessionId).presence_pickup).toBeNull();
  expect(history(h).map(row => row.status)).not.toContain("available");
  expect(history(h).at(-1)).toMatchObject({ status: "paused", reason: "Obed", ended_at: null });
}

describe("paused pickup source, failure and notification boundaries (application runner with fake provider/DB)", () => {
  it("PU-01 picks up the exact parked customer while preserving the original pause reason", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    for (const profile of Object.values(PROFILES)) h.setPresence(profile, { status: profile === PROFILES.o2 ? "available" : "offline" });
    await pause(h);
    const call = await h.inbound({ to: NUMBERS.allianz });
    await completeCallAnnouncements(h, call.sessionId);
    const oldOperator = String(h.legFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    await answer(h, oldOperator);
    await completeAnnouncedAction(h, parkCall(actionDeps(h), { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId));
    expect(h.session(call.sessionId).state).toBe("parked");
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    const picked = await pickupWaitingCall(actionDeps(h), actor, call.sessionId);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "ringing", pause_return: { pauseReasonId: pauseReason, sessionId: call.sessionId } });
    await answer(h, picked.operatorLegCallControlId!);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: actor.profileId, parked_at: null });
    expect(h.telnyx.physical.connected(call.callControlId, picked.operatorLegCallControlId!)).toBe(true);
    expect(h.telnyx.physical.connected(call.callControlId, oldOperator)).toBe(false);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", pause_return: { pauseReasonId: pauseReason } });
    expect(history(h).map(row => row.status)).not.toContain("available");
  });

  it.each(["cancel", "timeout"] as const)("PU-05 live pickup %s restores pause/history and leaves the customer alive", async exit => {
    const { h, call, backup } = await waitingWithPausedOperator();
    const picked = await pickupWaitingCall(actionDeps(h), actor, call.sessionId);
    const cc = picked.operatorLegCallControlId!;
    const token = String(h.presence(actor.profileId).offer_token);
    expect(h.telnyx.physical.legs.get(cc)?.ended).toBe(false);
    expect(h.telnyx.physical.connected(call.callControlId, cc)).toBe(false);
    if (exit === "cancel") {
      h.telnyx.physical.ended(cc);
      await h.legEvent(cc, "call.hangup", { hangup_cause: "originator_cancel" });
    } else {
      h.advance(61_000);
      vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
      expect(await runPendingEffectRecovery(h.deps)).toMatchObject({ status: "ok", detail: { checked: 1 } });
      expect(h.telnyx.physical.legs.get(cc)?.ended).toBe(true);
    }
    assertReturnedPause(h, call.sessionId);
    expect(h.session(call.sessionId).presence_cancellations).toHaveProperty(token);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    expect(h.telnyx.physical.legs.get(backup)?.ended).toBe(false);
    const revision = h.presence(actor.profileId).presence_revision;
    await h.legEvent(cc, "call.answered");
    expect(h.presence(actor.profileId).presence_revision).toBe(revision);
    assertReturnedPause(h, call.sessionId);
    expect(h.telnyx.physical.connected(call.callControlId, cc)).toBe(false);
  });

  it("PU-05 another already-offered branch wins while pickup rings, returning only the losing picker to pause", async () => {
    const { h, call, backup } = await waitingWithPausedOperator();
    const picked = await pickupWaitingCall(actionDeps(h), actor, call.sessionId);
    await answer(h, backup);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.physical.connected(call.callControlId, backup)).toBe(true);
    expect(h.telnyx.physical.legs.get(picked.operatorLegCallControlId!)?.ended).toBe(true);
    assertReturnedPause(h, call.sessionId);
    const revision = h.presence(actor.profileId).presence_revision;
    await h.legEvent(picked.operatorLegCallControlId!, "call.hangup", { hangup_cause: "originator_cancel" });
    expect(h.presence(actor.profileId).presence_revision).toBe(revision);
    expect(h.telnyx.physical.connected(call.callControlId, backup)).toBe(true);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  });

  it("PU-08 a near-limit pause cannot notify during pickup/work/wrap-up; the restored segment has its own warning", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    for (const profile of Object.values(PROFILES)) h.setPresence(profile, { status: "offline" });
    await pause(h);
    const originalPauseStartedAt = String(h.presence(actor.profileId).status_since);
    h.advance(43 * 60_000 + 50_000);
    h.db.update("motorist_operator_devices", { device_seen_at: h.now().toISOString() }, row => row.profile_id === actor.profileId);
    const call = await h.inbound({ to: NUMBERS.allianz });
    await completeCallAnnouncements(h, call.sessionId);
    const picked = await pickupWaitingCall(actionDeps(h), actor, call.sessionId);
    const assertNoOldWarning = async () => {
      expect(await materializePauseEndingNotification(h.admin, { ...own, expectedPauseStartedAt: originalPauseStartedAt, now: h.now() })).toMatchObject({ delivered: false });
      expect(await materializeDuePauseEndingNotifications(h.admin, ORG, h.now())).toMatchObject({ delivered: 0 });
      expect(h.rows("motorist_notifications")).toEqual([]);
      expect(sendPauseEndingPush).not.toHaveBeenCalled();
    };
    h.advance(20_000); // The old pause is now inside its final-minute warning window.
    expect(h.presence(actor.profileId).status).toBe("ringing");
    await assertNoOldWarning();
    await answer(h, picked.operatorLegCallControlId!);
    h.advance(10_000);
    expect(h.presence(actor.profileId).status).toBe("on_call");
    await assertNoOldWarning();
    await hangupCall(actionDeps(h), actor, call.sessionId);
    const until = String(h.presence(actor.profileId).wrap_up_until);
    h.advance(20_000);
    expect(h.presence(actor.profileId).status).toBe("after_call_work");
    await assertNoOldWarning();
    h.advance(20_000);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    expect(await sweepExpiredWrapUp(h.deps)).toMatchObject({ applied: 1, errors: [] });
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, status_since: until, pause_return: null });
    expect(await materializePauseEndingNotification(h.admin, { ...own, expectedPauseStartedAt: originalPauseStartedAt, now: h.now() })).toMatchObject({ status: "stale", delivered: false });
    await assertNoOldWarning();
    expect(history(h).map(row => row.status)).toEqual(["paused", "ringing", "on_call", "after_call_work", "paused"]);
    expect(history(h).at(-1)).toMatchObject({ reason: "Obed", started_at: until, ended_at: null });
    expect(history(h).at(-2)).toMatchObject({ ended_at: until });
    h.setNow(new Date(Date.parse(until) + 44 * 60_000).toISOString());
    expect(await materializeDuePauseEndingNotifications(h.admin, ORG, h.now())).toMatchObject({ delivered: 1 });
    expect(h.rows("motorist_notifications")).toEqual([expect.objectContaining({ dedupe_key: `pause-ending:${actor.profileId}:${until}` })]);
    expect(sendPauseEndingPush).toHaveBeenCalledOnce();
    expect(await materializeDuePauseEndingNotifications(h.admin, ORG, h.now())).toMatchObject({ duplicate: 1, delivered: 0 });
    expect(sendPauseEndingPush).toHaveBeenCalledOnce();
  });
});
