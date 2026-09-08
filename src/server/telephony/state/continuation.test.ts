import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { runPendingEffectRecovery, runRingSweep } from "../cron-jobs";
import { runSessionEvent } from "../session-runner";
import { blindTransfer, createRateLimiter } from "../call-actions";
import { setPresence } from "../presence-service";
import { readPendingEffects } from "./continuation";
import { readMeta, type SessionRow } from "./types";

afterEach(() => vi.unstubAllEnvs());
async function ringing(recording = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  if (recording) {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  }
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  return { h, call, operator };
}
const pending = (h: Awaited<ReturnType<typeof ringing>>["h"], sessionId: string) => readPendingEffects(h.session(sessionId) as SessionRow).entries;

describe("durable transition recovery", () => {
  it.each([
    ["motorist_call_legs", "update"],
    ["motorist_ring_attempts", "update"],
    ["motorist_ring_group_members", "update"],
    ["motorist_calls", "update"],
    ["motorist_call_events", "insert"],
  ] as const)("RC-03 recovers an answer interrupted at %s %s", async (table, operation) => {
    const { h, call, operator } = await ringing();
    const injected = vi.spyOn(h.db, "takeInjectedError");
    h.db.failNext(table, operation, "injected durable database boundary");
    await h.legEvent(operator, "call.answered");
    expect(injected.mock.results.some((result) => result.value?.message === "injected durable database boundary")).toBe(true);
    injected.mockRestore();
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o1)?.result).toBe("answered");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.rows("motorist_calls").find((row) => row.session_id === call.sessionId)?.status).toBe("answered");
  });

  it("RC-05 retains uncertain recording coverage after a failed START, audio connection and late recovery", async () => {
    const { h, call, operator } = await ringing(true);
    h.telnyx.failNext("recordingStart", "provider temporarily unavailable");
    await h.legEvent(operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    const gap = readMeta(h.session(call.sessionId) as SessionRow).recording!.coverageUnconfirmed;
    expect(gap).toMatchObject({ since: h.now().toISOString(), epoch: 0 });
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    const recording = readMeta(h.session(call.sessionId) as SessionRow).recording!;
    expect(recording.recorders.at(-1)?.observed).toBe("recording");
    expect(recording.coverageUnconfirmed).toEqual(gap);
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.rows("motorist_call_events").some((event) =>
      (event.normalized_payload as { recording_coverage_unconfirmed?: unknown })?.recording_coverage_unconfirmed)).toBe(true);
    await h.legEvent(call.callControlId, "call.hangup");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording!.coverageUnconfirmed).toEqual(gap);
  });

  it("retries an atomic staging conflict through the runner instead of failing the answer", async () => {
    const { h, call, operator } = await ringing();
    const handler = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let conflicts = 0;
    h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      if (conflicts++ === 0) return { applied: false };
      return handler(args, db);
    });
    const result = await h.legEvent(operator, "call.answered");
    expect(result.outcome).toBe("processed");
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(pending(h, call.sessionId)).toEqual([]);
  });

  it.each([false, true])("RC-01/02/08 recovers a partial answer from cron with recording=%s", async (recording) => {
    const { h, call, operator } = await ringing(recording);
    h.db.failNext("motorist_ring_attempts", "update", "attempt database unavailable");
    const result = await h.legEvent(operator, "call.answered");
    expect(result.outcome).toBe("failed");
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(pending(h, call.sessionId)).toHaveLength(1);
    h.advance(5 * 60_000);
    const recovered = await runPendingEffectRecovery(h.deps);
    expect(recovered.status).toBe("ok");
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o1)?.result).toBe("answered");
    expect(h.presence(PROFILES.o1).status).toBe("on_call");
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(pending(h, call.sessionId)).toEqual([]);
    if (recording) expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  });

  it("RC-04 repeats the stable bridge after the provider executed it but lost the response", async () => {
    const { h, call, operator } = await ringing();
    h.telnyx.loseNextResponse("bridge");
    await h.legEvent(operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(pending(h, call.sessionId)).toHaveLength(1);
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(h.telnyx.physical.connections()).toHaveLength(1);
    expect(pending(h, call.sessionId)).toEqual([]);
  });

  it.each(["conference:join", "recordingStart"])("RC-04/05 recovers accepted %s with a lost response through one cron", async method => {
    const { h, call, operator } = await ringing(true);
    h.telnyx.loseNextResponse(method);
    await h.legEvent(operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(pending(h, call.sessionId).length).toBeGreaterThan(0);
    const gap = readMeta(h.session(call.sessionId) as SessionRow).recording?.coverageUnconfirmed;
    if (method === "recordingStart") expect(gap).toBeTruthy();
    const legs = h.telnyx.physical.legs.size;
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.telnyx.physical.legs.size).toBe(legs);
    expect(h.telnyx.physical.connections()).toHaveLength(1);
    const retried = h.telnyx.of(method);
    expect(retried.length).toBeGreaterThan(1);
    expect(new Set(retried.map(item => item.params.commandId ?? item.params.command_id)).size).toBe(1);
    const capture = readMeta(h.session(call.sessionId) as SessionRow).recording!;
    expect(capture.recorders.filter(recorder => recorder.observed === "recording")).toHaveLength(1);
    if (method === "recordingStart") expect(capture.coverageUnconfirmed).toEqual(gap);
  });

  it.each(["hangup", "accepted-transfer"] as const)("RC-03/07 recovers an owner release failure after %s", async boundary => {
    const { h, call, operator } = await ringing();
    await h.legEvent(operator, "call.answered");
    for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    }
    await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "available" });
    const handler = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
    let failed = false;
    h.db.registerRpc("motorist_presence_transition_v1", (args, db) => {
      if (!failed && args.p_action === "release" && args.p_profile_id === PROFILES.o1) {
        failed = true; throw new Error("one-shot release database failure");
      }
      return handler(args, db);
    });
    const beforeDials = h.telnyx.of("dial").length;
    if (boundary === "hangup") {
      h.telnyx.physical.ended(call.callControlId);
      await h.legEvent(call.callControlId, "call.hangup");
      expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(true);
    } else {
      await expect(completeAnnouncedAction(h, blindTransfer({ ...h.deps, rateLimiter: createRateLimiter() }, { profileId: PROFILES.o1, role: "dispatcher" },
        call.sessionId, { profileId: PROFILES.o2 }))).rejects.toMatchObject({ status: 502 });
      expect(h.telnyx.of("dial")).toHaveLength(beforeDials + 1);
      expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(false);
    }
    expect(failed).toBe(true);
    expect(pending(h, call.sessionId).length).toBeGreaterThan(0);
    h.advance(5 * 60_000);
    // The existing cron runs stale-leg finalization before journal recovery.
    if (boundary === "hangup") expect((await runRingSweep(h.deps)).status).toBe("ok");
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
    expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(true);
    if (boundary === "hangup") expect(h.session(call.sessionId).ended_at).toBeTruthy();
    else {
      const targetDials = h.telnyx.of("dial").slice(beforeDials);
      expect(new Set(targetDials.map(item => item.params.commandId)).size).toBe(1);
      expect(h.legs(call.sessionId).filter(leg => leg.profile_id === PROFILES.o2 && !leg.ended_at)).toHaveLength(1);
    }
  });

  it("RC-06 a hangup invalidates the old bridge but completes the remaining database effects", async () => {
    const { h, call, operator } = await ringing();
    h.db.failNext("motorist_ring_attempts", "update", "attempt database unavailable");
    await h.legEvent(operator, "call.answered");
    await h.legEvent(call.callControlId, "call.hangup");
    h.advance(5 * 60_000);
    await runPendingEffectRecovery(h.deps);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
  });

  it("RC-03 retries a database checkpoint after the physical bridge without compensating it", async () => {
    const { h, call, operator } = await ringing();
    const bridge = h.telnyx.client.bridge.bind(h.telnyx.client);
    let once = true;
    vi.spyOn(h.telnyx.client, "bridge").mockImplementation(async (input) => {
      const result = await bridge(input);
      if (once) { once = false; h.db.failNext("motorist_call_sessions", "update", "checkpoint unavailable"); }
      return result;
    });
    await h.legEvent(operator, "call.answered");
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === operator)).toBe(false);
    h.advance(31_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "recovery", occurredAt: h.now().toISOString(), actorProfileId: null });
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
  });
});
