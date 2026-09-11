import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { addCallParty, blindTransfer, callColleague, createRateLimiter, leaveConferenceCall, pickupWaitingCall } from "../call-actions";
import { runPendingEffectRecovery } from "../cron-jobs";
import { setPresence } from "../presence-service";
import { TelnyxCommandError } from "../telnyx/client";
import { readPendingEffects } from "./continuation";
import { readMeta, type SessionRow } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const pauseReason = "00000000-0000-4000-8000-000000002501";
const personalNumber = "+421911222333";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world(recording = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  if (recording) {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  }
  return h;
}
const actionDeps = (h: TelephonyHarness) => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
const pending = (h: TelephonyHarness, sessionId: string) => readPendingEffects(h.session(sessionId) as SessionRow).entries;
async function answer(h: TelephonyHarness, cc: string) {
  h.telnyx.physical.answered(cc);
  return h.legEvent(cc, "call.answered");
}
async function talking(recording: boolean) {
  const h = world(recording);
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  await answer(h, operator);
  await completeCallAnnouncements(h, call.sessionId);
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== actor.profileId && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
  return { h, call, operator };
}

function assertOriginalConversation(h: TelephonyHarness, sessionId: string, customer: string, operator: string, token: unknown) {
  expect(h.telnyx.physical.legs.get(customer)?.ended).toBe(false);
  expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(false);
  expect(h.telnyx.physical.connected(customer, operator)).toBe(true);
  expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: sessionId, offer_token: token });
}

describe("V1 ownership and provider prerequisites through the staged runner", () => {
  it.each(["bridge", "dial"] as const)("recording-disabled lease loss fences %s and a later valid lease completes it", async kind => {
    const h = world();
    let sessionId: string, source: string;
    if (kind === "bridge") {
      const call = await h.inbound({ to: NUMBERS.allianz });
      await completeCallAnnouncements(h, call.sessionId);
      sessionId = call.sessionId;
      source = String(h.legFor(sessionId, actor.profileId)!.telnyx_call_control_id);
    } else {
      const call = await callColleague(actionDeps(h), actor, { targetProfileId: PROFILES.o2 });
      sessionId = call.sessionId; source = call.operatorLegCallControlId!;
    }
    const before = { bridge: h.telnyx.of("bridge").length, dial: h.telnyx.of("dial").length };
    const acquire = h.db.rpcHandlers.get("motorist_session_lease_acquire")!;
    let attempts = 0;
    h.db.registerRpc("motorist_session_lease_acquire", (args, db) => ++attempts === 1 ? acquire(args, db) : false);
    const result = await answer(h, source);
    expect(attempts).toBeGreaterThan(1);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("session lease unavailable");
    expect(h.telnyx.of("bridge")).toHaveLength(before.bridge);
    expect(h.telnyx.of("dial")).toHaveLength(before.dial);
    expect(pending(h, sessionId).length).toBeGreaterThan(0);
    h.db.registerRpc("motorist_session_lease_acquire", acquire);
    h.advance(31_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, sessionId)).toEqual([]);
    expect(h.telnyx.of(kind)).toHaveLength(before[kind] + 1);
    if (kind === "bridge") {
      const customer = h.legs(sessionId).find(leg => leg.role === "customer")!;
      expect(h.telnyx.physical.connected(String(customer.telnyx_call_control_id), source)).toBe(true);
    } else expect(h.openLegFor(sessionId, PROFILES.o2)).toBeTruthy();
  });

  it.each(["web", "owned_pstn"].flatMap(target => [false, true].map(recording => ({ target, recording }))))(
    "a paused target rejects the skipped $target transfer without handing over the original conversation, recording=$recording", async ({ target, recording }) => {
      const { h, call, operator } = await talking(recording);
      const token = h.presence(actor.profileId).offer_token;
      await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "available" });
      if (target === "owned_pstn") {
        h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: PROFILES.o2, default_mobile_number: personalNumber });
        h.db.delete("motorist_operator_devices", row => row.profile_id === PROFILES.o2);
      }
      const beforeDials = h.telnyx.of("dial").length;
      let barrierReached = false;
      let commandsAtBarrier = -1;
      const dispatch = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
      h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
        if (args.p_action === "dispatch" && args.p_profile_id === PROFILES.o2 && !barrierReached) {
          barrierReached = true;
          commandsAtBarrier = h.telnyx.calls.length;
          await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "paused", pauseReasonId: pauseReason });
        }
        return dispatch(args, db);
      });
      const destination = target === "web" ? { profileId: PROFILES.o2 } : { number: personalNumber };
      await expect(completeAnnouncedAction(h, blindTransfer(actionDeps(h), actor, call.sessionId, destination))).rejects.toMatchObject({ status: recording ? 502 : 409 });
      expect(barrierReached).toBe(true);
      expect(h.telnyx.of("dial")).toHaveLength(beforeDials);
      assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
      expect(h.presence(PROFILES.o2)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null });
      expect(h.telnyx.calls.slice(commandsAtBarrier).filter(command =>
        command.method === "recordingStop" || command.method === "conference:leave" ||
        command.method === "hangup" && [operator, call.callControlId].includes(String(command.params.callControlId)))).toEqual([]);
      h.advance(31_000);
      await runPendingEffectRecovery(h.deps);
      assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
      expect(h.telnyx.of("dial")).toHaveLength(beforeDials);
      if (recording) {
        const capture = readMeta(h.session(call.sessionId) as SessionRow).recording!;
        expect(capture.recorders.some(recorder => recorder.observed === "recording")).toBe(true);
        expect(capture.coverageUnconfirmed).toBeTruthy();
      }
    },
  );

  it.each(["web", "owned_pstn", "independent_pstn"].flatMap(target => [false, true].map(recording => ({ target, recording }))))(
    "persistent 422 blind transfer to $target preserves original audio and ownership, recording=$recording", async ({ target, recording }) => {
      const { h, call, operator } = await talking(recording);
      const token = h.presence(actor.profileId).offer_token;
      await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "available" });
      if (target === "owned_pstn") {
        h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: PROFILES.o2, default_mobile_number: personalNumber });
        h.db.delete("motorist_operator_devices", row => row.profile_id === PROFILES.o2);
      }
      const method = target === "independent_pstn" && !recording ? "transfer" : "dial";
      const before = h.telnyx.of(method).length;
      h.telnyx.failAlways(method, new TelnyxCommandError({ code: "invalid_destination", status: 422, detail: "persistent transfer rejection" }));
      const destination = target === "web" ? { profileId: PROFILES.o2 } : { number: target === "owned_pstn" ? personalNumber : NUMBERS.external };
      await expect(completeAnnouncedAction(h, blindTransfer(actionDeps(h), actor, call.sessionId, destination))).rejects.toMatchObject({ status: 502 });
      expect(h.telnyx.of(method).length).toBeGreaterThan(before);
      assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
      h.advance(31_000);
      await runPendingEffectRecovery(h.deps);
      assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
    },
  );

  it.each([false, true])("persistent conference leave failure keeps the operator physically connected and owned, recording=%s", async recording => {
    const { h, call, operator } = await talking(recording);
    await completeAnnouncedAction(h, addCallParty(actionDeps(h), actor, call.sessionId, { number: NUMBERS.external }));
    const party = String(h.legByNumber(call.sessionId, NUMBERS.external)!.telnyx_call_control_id);
    await answer(h, party);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("conference");
    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);
    const token = h.presence(actor.profileId).offer_token;
    const before = h.telnyx.of("conference:leave").length;
    h.telnyx.failAlways("conference:leave", new TelnyxCommandError({ code: "call_not_participant", status: 422, detail: "persistent leave rejection" }));
    await expect(completeAnnouncedAction(h, leaveConferenceCall(actionDeps(h), actor, call.sessionId))).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("conference:leave").length).toBeGreaterThan(before);
    assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
    expect(h.telnyx.physical.connected(operator, party)).toBe(true);
    h.advance(31_000);
    await runPendingEffectRecovery(h.deps);
    assertOriginalConversation(h, call.sessionId, call.callControlId, operator, token);
  });

  it.each(["call.hangup", "call.answered"])("legacy tokenless %s cannot borrow the newer same-session paused pickup token", async event => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    await completeCallAnnouncements(h, call.sessionId);
    const old = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
    expect(h.clientStateOf(old).offerToken).toBeUndefined();
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    await setPresence(h.deps, { organizationId: ORG, profileId: actor.profileId, status: "paused", pauseReasonId: pauseReason });
    const picked = await pickupWaitingCall(actionDeps(h), actor, call.sessionId);
    expect(picked.operatorLegCallControlId).toBeTruthy();
    expect(picked.operatorLegCallControlId).not.toBe(old);
    const ownership = structuredClone(h.presence(actor.profileId));
    expect(ownership).toMatchObject({ status: "ringing", current_session_id: call.sessionId, offer_token: expect.any(String), pause_return: { pauseReasonId: pauseReason } });
    await h.legEvent(old, event);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "ringing", current_session_id: call.sessionId,
      offer_token: ownership.offer_token, presence_revision: ownership.presence_revision, pause_return: ownership.pause_return });
    expect(h.session(call.sessionId).presence_pickup).toMatchObject({ profileId: actor.profileId, offerToken: ownership.offer_token });
    expect(h.telnyx.physical.legs.get(picked.operatorLegCallControlId!)?.ended).toBe(false);
  });
});
