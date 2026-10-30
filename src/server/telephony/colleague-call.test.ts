import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, CallActionError, createRateLimiter, hangupCall, holdCall, INTERNAL_CALL_CUSTOMER_RESERVE, pickupWaitingCall, type CallActionDeps, type CallActor } from "./call-actions";
import { loadRoutingContext, loadSessionSnapshot, runSessionEvent } from "./session-runner";
import { CallActionRejected, reduce } from "./state/transitions";
import type { AppEvent } from "./state/types";
import { loadCallPushCandidates } from "./call-notifications";

/**
 * Colleague calls from Ústredňa → Operátori (owner decisions, 28 Sep 2026):
 * the colleague's application phone rings — also on pause, which it keeps —
 * either person leaving ends the call for both, customers keep capacity, and
 * both people see names rather than company lines or phone addresses.
 */

const jana: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana Nováková" };

const MODES = [
  { name: "legacy", stability: false },
  { name: "stability", stability: true },
  { name: "contract 2", stability: true, writerContract: 2 as const },
];

function deps(h: TelephonyHarness): CallActionDeps {
  return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
}

async function fail(promise: Promise<unknown>): Promise<CallActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallActionError) return error;
    throw error;
  }
  throw new Error("expected a CallActionError");
}

afterEach(() => vi.unstubAllEnvs());

describe.each(MODES)("colleague call ($name)", ({ stability, writerContract }) => {
  function world(): TelephonyHarness {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", stability ? "true" : "false");
    return createTelephonyHarness(writerContract ? { writerContract } : {});
  }

  async function ringing(h: TelephonyHarness, actor: CallActor = jana, target: string = PROFILES.o2) {
    const call = await callColleague(deps(h), actor, { targetProfileId: target, requestId: randomUUID() });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    const callee = h.openLegFor(call.sessionId, target);
    if (!callee) throw new Error("the colleague's phone was not dialled");
    return { ...call, caller: call.operatorLegCallControlId, callee: String(callee.telnyx_call_control_id) };
  }

  async function talking(h: TelephonyHarness, actor: CallActor = jana, target: string = PROFILES.o2) {
    const call = await ringing(h, actor, target);
    await h.legEvent(call.callee, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    return call;
  }

  const hungUp = (h: TelephonyHarness, callControlId: string) =>
    h.telnyx.of("hangup").some((command) => command.params.callControlId === callControlId);

  it("rings a colleague on pause, keeps them paused and has nothing to restore afterwards", async () => {
    const h = world();
    h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    const call = await talking(h);
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "paused", current_session_id: null });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });

    await h.legEvent(call.callee, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(hungUp(h, call.caller)).toBe(true);
    await h.legEvent(call.caller, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "paused", current_session_id: null });
    // A colleague call leaves nothing to write up.
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("lets an operator on pause call a colleague and keeps the caller's pause", async () => {
    const h = world();
    h.setPresence(PROFILES.o1, { status: "paused", current_session_id: null });
    const call = await talking(h);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "paused", current_session_id: null });
    await hangupCall(deps(h), jana, call.sessionId);
    for (const id of [call.caller, call.callee]) await h.legEvent(id, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "paused", current_session_id: null });
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("ends the call for the colleague when the caller hangs up, instead of parking them as a customer", async () => {
    const h = world();
    const call = await talking(h);
    await h.legEvent(call.caller, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(hungUp(h, call.callee)).toBe(true);
    expect(["wrap_up", "ended"]).toContain(h.session(call.sessionId).state);
    await h.legEvent(call.callee, "call.hangup", { hangup_cause: "normal_clearing" });
    const session = h.session(call.sessionId);
    expect(session.state).toBe("ended");
    expect(session.parked_at ?? null).toBeNull();
    expect((session.metadata as Record<string, unknown>).waiting ?? null).toBeNull();
    expect(h.telnyx.of("playbackStart").some((command) => command.params.callControlId === call.callee)).toBe(false);
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(h.presence(profileId)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("stops ringing the colleague when the caller's own leg drops first", async () => {
    const h = world();
    const call = await ringing(h);
    await h.legEvent(call.caller, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(hungUp(h, call.callee)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended" });
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(h.presence(profileId)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("ends the caller's leg too when the colleague declines", async () => {
    const h = world();
    const call = await ringing(h);
    await h.legEvent(call.callee, "call.hangup", { hangup_cause: "call_rejected", sip_hangup_cause: "603" });
    expect(hungUp(h, call.caller)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended" });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("refuses a colleague who is on a call, finishing one, logged out or without a phone", async () => {
    const h = world();
    h.setPresence(PROFILES.o2, { status: "on_call", current_session_id: randomUUID() });
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2 }))).toMatchObject({ status: 409, code: "colleague_busy", message: "Kolega práve telefonuje." });
    h.setPresence(PROFILES.o2, { status: "after_call_work", current_session_id: null, wrap_up_until: new Date(h.now().getTime() + 20_000).toISOString() });
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2 }))).toMatchObject({ code: "colleague_wrap_up" });
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o4 }))).toMatchObject({ code: "colleague_offline" });
    h.setPresence(PROFILES.o2, { status: "available", current_session_id: null, wrap_up_until: null });
    h.touchDevice(PROFILES.o2, 10 * 60_000);
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2 }))).toMatchObject({ code: "colleague_no_phone", message: "Kolega nemá zapnutý telefón v aplikácii." });
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("never takes the capacity customers need", async () => {
    const h = world();
    const reserved = 2 + INTERNAL_CALL_CUSTOMER_RESERVE;
    h.db.update("motorist_telephony_settings", { max_concurrent_legs: reserved - 1 }, () => true);
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2 }))).toMatchObject({ status: 409, code: "colleague_capacity" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    h.db.update("motorist_telephony_settings", { max_concurrent_legs: reserved }, () => true);
    await expect(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2, requestId: randomUUID() })).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("names both people instead of the company line or a phone address", async () => {
    const h = world();
    const call = await talking(h);
    expect((h.session(call.sessionId).metadata as Record<string, unknown>).internal).toMatchObject({
      target_profile_id: PROFILES.o2, caller_name: "Jana Nováková", target_name: "Peter Dispečer", caller_display: "Jana Novakova",
    });
    const colleagueDial = h.telnyx.of("dial").find((command) => command.params.to === "sip:gencred002@sip.telnyx.com");
    expect(colleagueDial?.params.fromDisplayName).toBe("Jana Novakova");
    // The browser lets only this marked invite ring through a pause, never auto-answering it.
    expect(colleagueDial?.params.customHeaders).toEqual([{ name: "X-PM-Colleague-Call", value: "1" }]);
    const row = h.call(call.sessionId)!;
    expect(row).toMatchObject({ direction: "internal", caller_name: "Jana Nováková" });
    expect((row.raw_latest_payload as Record<string, unknown>).internal).toEqual({ caller_name: "Jana Nováková", target_name: "Peter Dispečer" });
  });

  it.each([false, true])("accepts in the mobile app, survives the periodic check and ends cleanly (paused=%s)", async (paused) => {
    const h = world();
    h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development", sip_username: `mobile-${PROFILES.o2}`,
      telnyx_credential_id: `mobile-${PROFILES.o2}`, device_session_id: "mobile-session", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
    if (paused) h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    const call = await ringing(h);
    const peter: CallActor = { profileId: PROFILES.o2, role: "dispatcher" };
    const mobile = await pickupWaitingCall({ ...deps(h), deviceKind: "mobile" }, peter, call.sessionId);
    const mobileLeg = mobile.operatorLegCallControlId!;
    await h.legEvent(mobileLeg, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    // The pickup claim expires after a minute; the periodic sweep must not cut the call.
    h.advance(6 * 60_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: `sweep-${randomUUID()}`, actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(hungUp(h, mobileLeg)).toBe(false);
    expect(h.session(call.sessionId).state).toBe("talking");
    await hangupCall(deps(h), peter, call.sessionId);
    for (const leg of h.legs(call.sessionId)) if (!leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", presence_pickup: null });
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: paused ? "paused" : "available", current_session_id: null });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });

  // Holding a colleague call promoted it to a conference from the caller's leg,
  // which hung up the colleague: reproduced on TEST on 30 Oct.
  it.each(["hold", "unhold", "park", "blind_transfer", "consult", "complete_transfer", "cancel_consult", "add_party", "invite_monitor", "supervise"] as const)(
    "refuses %s on a colleague call without a command", async (type) => {
      const h = world();
      const call = await talking(h);
      const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
      const event: AppEvent = { kind: "app", id: randomUUID(), type, actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString(),
        target: { kind: "number", number: "+421900000000", label: "Číslo" },
        supervisor: { profileId: PROFILES.o4, sipUri: "sip:gencred004@sip.telnyx.com", mode: "monitor", label: "Manažér" } };
      const context = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
      let refused: unknown = null;
      try { reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context); }
      catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(CallActionRejected);
      expect(refused).toMatchObject({ status: 409, code: "not_supported_internal" });
    });

  it("answers a hold of a colleague call with 409 and keeps both people connected", async () => {
    const h = world();
    const call = await talking(h);
    const commands = h.telnyx.calls.length;
    expect(await fail(holdCall(deps(h), jana, call.sessionId))).toMatchObject({ status: 409, code: "not_supported_internal" });
    expect(h.telnyx.calls).toHaveLength(commands);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", conference_id: null });
    expect(h.legs(call.sessionId).filter((leg) => !leg.ended_at).map((leg) => leg.telnyx_call_control_id).sort()).toEqual([call.caller, call.callee].sort());
    // Hanging up stays available.
    await hangupCall(deps(h), jana, call.sessionId);
    expect(hungUp(h, call.callee)).toBe(true);
  });

  it("wakes a paused colleague's mobile with the caller's name", async () => {
    const h = world();
    h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    const call = await ringing(h);
    const candidates = await loadCallPushCandidates({ admin: h.deps.admin, organizationId: ORG, environment: "development", now: h.now }, call.sessionId);
    expect(candidates).toEqual([expect.objectContaining({
      recipientProfileId: PROFILES.o2, category: "incoming_call", title: "Volá kolega", body: "Jana Nováková · Otvorte aplikáciu a prijmite hovor.",
    })]);
  });
});

describe("colleague call to a personal mobile", () => {
  it("explains that it is not available instead of dialling the private number", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: PROFILES.o2, delivery_mode: "personal_mobile", default_mobile_number: "+421911222333" });
    expect(await fail(callColleague(deps(h), jana, { targetProfileId: PROFILES.o2 }))).toMatchObject({ code: "colleague_personal_mobile" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });
});
