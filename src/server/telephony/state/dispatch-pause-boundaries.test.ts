import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { blindTransfer, callColleague, createRateLimiter } from "../call-actions";
import { runPendingEffectRecovery } from "../cron-jobs";
import { setPresence } from "../presence-service";
import { effectsDeps } from "../session-runner";
import { decodeClientState } from "../telnyx/client-state";
import { TelnyxCommandError } from "../telnyx/client";
import { cancelRevokedOffers } from "./cancelled-offers";
import type { SessionRow } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const targetProfile = PROFILES.o2;
const pauseReason = "00000000-0000-4000-8000-000000002501";
const mobileNumber = "+421911222333";
const routes = ["ring_web", "ring_pstn", "internal", "blind_web", "blind_pstn"] as const;
const windows = ["before_authorization", "authorized_before_send", "response_pending", "identity_persisted"] as const;
type Route = typeof routes[number];
type Window = typeof windows[number];
type Case = { route: Route; window: Window; recording: boolean; failedHangup: boolean };
const cases: Case[] = routes.flatMap(route => [false, true].flatMap(recording => windows.map(window => ({ route, recording, window, failedHangup: false }))));
// A failed first cancellation must remain recoverable when the provider's late
// answer supplies the exact offer identity. This is fake-provider verification.
const retryCases: Case[] = routes.flatMap(route => [false, true].map(recording => ({ route, recording, window: "response_pending", failedHangup: true })));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world(recording: boolean) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  if (recording) {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  }
  return h;
}

async function answer(h: TelephonyHarness, id: string) {
  h.telnyx.physical.answered(id);
  await h.legEvent(id, "call.answered");
}

async function prepare(h: TelephonyHarness, route: Route, rejectedBeforeDispatch: boolean, recording: boolean) {
  const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  if (route.startsWith("ring")) {
    if (route === "ring_pstn") {
      h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: targetProfile, default_mobile_number: mobileNumber, delivery_mode: "personal_mobile" });
      h.db.delete("motorist_operator_devices", row => row.profile_id === targetProfile);
    }
    return async () => {
      const call = await h.inbound({ to: NUMBERS.allianz });
      await completeCallAnnouncements(h, call.sessionId);
      return { sessionId: call.sessionId, source: call.callControlId };
    };
  }
  if (route === "internal") {
    const call = await callColleague(deps, actor, { targetProfileId: targetProfile });
    return async () => {
      await answer(h, call.operatorLegCallControlId!);
      await completeCallAnnouncements(h, call.sessionId);
      return { sessionId: call.sessionId, source: call.operatorLegCallControlId! };
    };
  }
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  await answer(h, operator);
  await completeCallAnnouncements(h, call.sessionId);
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== actor.profileId && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  await setPresence(h.deps, { organizationId: ORG, profileId: targetProfile, status: "available" });
  if (route === "blind_pstn") {
    h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: targetProfile, default_mobile_number: mobileNumber });
    h.db.delete("motorist_operator_devices", row => row.profile_id === targetProfile);
  }
  return async () => {
    const action = completeAnnouncedAction(h, blindTransfer(deps, actor, call.sessionId, route === "blind_pstn" ? { number: mobileNumber } : { profileId: targetProfile }));
    // Silent controls reject within the HTTP action; recorded actions report
    // the same rejection through their later announcement completion.
    if (rejectedBeforeDispatch) await expect(action).rejects.toMatchObject({ status: recording ? 502 : 409 });
    else await action;
    return { sessionId: call.sessionId, source: call.callControlId };
  };
}

async function verifyBoundary({ route, window, recording, failedHangup }: Case) {
  const h = world(recording);
  const start = await prepare(h, route, route.startsWith("blind") && window === "before_authorization", recording);
  const dialsBefore = h.telnyx.of("dial").length;
  let paused = false;
  let unknownIdentityObserved = false;
  let rejectedToken: string | null = null;
  let failedControlId: string | null = null;
  let cancellationFailures = 0;
  const hangup = h.telnyx.client.hangup.bind(h.telnyx.client);
  vi.spyOn(h.telnyx.client, "hangup").mockImplementation(async input => {
    if (input.callControlId === failedControlId) {
      cancellationFailures += 1;
      throw new TelnyxCommandError({ code: "provider_unavailable", status: 503, retryable: true });
    }
    return hangup(input);
  });
  const pause = async (sessionId: string) => {
    expect(paused).toBe(false);
    paused = true;
    rejectedToken = h.presence(targetProfile).offer_token as string | null;
    await setPresence(h.deps, { organizationId: ORG, profileId: targetProfile, status: "paused", pauseReasonId: pauseReason });
    await cancelRevokedOffers(effectsDeps(h.deps), h.session(sessionId) as SessionRow);
  };
  const rpc = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
  h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
    const selectedDispatch = args.p_action === "dispatch" && args.p_profile_id === targetProfile && !paused;
    if (selectedDispatch && window === "before_authorization") await pause(String(args.p_session_id));
    const result = await rpc(args, db);
    if (selectedDispatch && window === "authorized_before_send") {
      expect(result).toMatchObject({ applied: true, offerToken: expect.any(String) });
      expect(h.telnyx.of("dial").slice(dialsBefore).some(command => decodeClientState(command.params.clientState)?.operatorId === targetProfile)).toBe(false);
      await pause(String(args.p_session_id));
    }
    return result;
  });
  const dial = h.telnyx.client.dial.bind(h.telnyx.client);
  vi.spyOn(h.telnyx.client, "dial").mockImplementation(async input => {
    const result = await dial(input);
    const state = decodeClientState(input.clientState);
    if (state?.operatorId === targetProfile && window === "response_pending" && !paused) {
      // Provider has accepted the HTTP command and created the leg, but its
      // response has not returned to executeDial/upsertDialedLeg yet.
      expect(h.db.find("motorist_call_legs", leg => leg.telnyx_call_control_id === result.callControlId)).toBeNull();
      unknownIdentityObserved = true;
      h.telnyx.physical.answered(result.callControlId);
      expect(h.telnyx.physical.connections().some(pair => pair.includes(result.callControlId))).toBe(false);
      await pause(state.sid);
      expect(h.session(state.sid).presence_cancellations).toHaveProperty(state.offerToken!);
      expect(h.telnyx.physical.legs.get(result.callControlId)?.ended).toBe(false);
      if (failedHangup) failedControlId = result.callControlId;
    }
    return result;
  });

  const call = await start();
  const targetDials = () => h.telnyx.of("dial").slice(dialsBefore).filter(command => decodeClientState(command.params.clientState)?.operatorId === targetProfile);
  if (window === "identity_persisted") await pause(call.sessionId);
  expect(paused).toBe(true);
  expect(h.presence(targetProfile)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null });
  if (window === "before_authorization") {
    expect(targetDials()).toEqual([]);
    if (route.startsWith("blind")) {
      const operator = h.legFor(call.sessionId, actor.profileId)!;
      expect(h.telnyx.physical.connected(call.source, String(operator.telnyx_call_control_id))).toBe(true);
      expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    }
  } else {
    expect(targetDials()).toHaveLength(1);
    if (route.endsWith("pstn")) expect(targetDials()[0].params.to).toBe(mobileNumber);
    const state = decodeClientState(targetDials()[0].params.clientState)!;
    const leg = h.legs(call.sessionId).find(row => (row.client_state as { offerToken?: string } | null)?.offerToken === state.offerToken)!;
    expect(leg).toBeDefined();
    const cc = String(leg.telnyx_call_control_id);
    expect(state.offerToken).toBe(rejectedToken);
    expect(h.session(call.sessionId).presence_cancellations).toHaveProperty(state.offerToken!);
    if (window === "response_pending") expect(unknownIdentityObserved).toBe(true);
    if (failedHangup) {
      expect(h.session(call.sessionId).cancellations_next_attempt_at).toBeTruthy();
      expect(h.telnyx.physical.legs.get(cc)?.ended).toBe(false);
      expect(cancellationFailures).toBeGreaterThan(0);
      failedControlId = null;
    }
    // A physical answer may happen before the webhook, including a late answer
    // to an already revoked offer. There must be no pre-armed connection.
    h.telnyx.physical.answered(cc);
    expect(h.telnyx.physical.connected(call.source, cc)).toBe(false);
    await h.legEvent(cc, "call.answered");
    await h.legEvent(cc, "call.answered", {}, `late-duplicate-${route}-${window}-${recording}`);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.physical.legs.get(cc)?.ended).toBe(true);
    expect(h.telnyx.physical.connections().some(pair => pair.includes(cc))).toBe(false);
    expect(h.presence(targetProfile)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null });
  }
  if (route.startsWith("ring")) {
    expect(h.telnyx.physical.legs.get(call.source)?.ended).toBe(false);
    for (const profile of [PROFILES.o1, PROFILES.o5]) {
      const other = h.legFor(call.sessionId, profile)!;
      expect(other).toBeDefined();
      expect(h.telnyx.physical.legs.get(String(other.telnyx_call_control_id))?.ended).toBe(false);
    }
  }
  if (route.startsWith("blind")) expect(h.telnyx.physical.legs.get(call.source)?.ended).toBe(false);
  const count = targetDials().length;
  h.advance(31_000);
  await runPendingEffectRecovery(h.deps);
  expect(targetDials()).toHaveLength(count);
  expect(h.presence(targetProfile)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null });
}

describe("PA-04 deterministic dispatch boundaries (FakeSupabase and modeled provider topology)", () => {
  it.each(cases)("$route / $window / recording=$recording", verifyBoundary);
  it.each(retryCases)("$route / late identity and failed cancellation / recording=$recording", verifyBoundary);
});
