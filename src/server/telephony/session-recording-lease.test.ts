import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { loadRoutingContext } from "./session-runner";
import { requiresRecordingLease } from "./state/recording";
import { readMeta, toJson, type SessionRow } from "./state/types";

afterEach(() => vi.unstubAllEnvs());

async function ringing(announcements = false, durable = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
  for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness({ leaseWaitMs: 1, sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), inboundStartAnnouncements: announcements } } }, () => true);
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  const state = () => readMeta(h.session(call.sessionId) as SessionRow).recording!;
  await h.admin.rpc("motorist_session_lease_acquire", { p_session_id: call.sessionId, p_token: "other-request", p_ttl_ms: 60_000 });
  h.telnyx.physical.answered(operator);
  return { h, call, operator, state };
}

describe("per-call recording lease requirements", () => {
  it("does not reject a legacy silent call because the organization's recording policy is enabled", async () => {
    const { h, call, operator, state } = await ringing();
    expect(state().policy).toMatchObject({ enabled: false, reason: "start_announcements_disabled" });

    const result = await h.legEvent(operator, "call.answered");

    expect(result.outcome).toBe("processed");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", lease_token: "other-request" });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
    expect(state().policy.enabled).toBe(false);
  });

  it("still serializes a call whose frozen and live policies allow recording", async () => {
    const { h, call, operator, state } = await ringing(true);
    expect(state().policy.enabled).toBe(true);
    const commands = h.telnyx.calls.length;
    const result = await h.legEvent(operator, "call.answered");
    expect(result).toMatchObject({ status: 500, outcome: "failed", error: expect.stringContaining("Prebieha zmena nahrávania") });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.calls).toHaveLength(commands);
  });

  it("retains durable session serialization even when recording is disabled for the call", async () => {
    const { h, call, operator } = await ringing(false, true);
    const commands = h.telnyx.calls.length;
    const result = await h.legEvent(operator, "call.answered");
    expect(result).toMatchObject({ status: 500, outcome: "failed", error: expect.stringContaining("Prebieha zmena hovoru") });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.calls).toHaveLength(commands);
  });

  it.each([false, true])("replays the same answered event immediately after lease release (durable=%s)", async durable => {
    const { h, call, operator } = await ringing(!durable, durable);
    const before = h.now().getTime();
    const id = "contended-answer";
    expect(await h.legEvent(operator, "call.answered", {}, id)).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === id)).toMatchObject({ status: "failed", claimed_at: null, attempts: 1 });
    await h.admin.rpc("motorist_session_lease_release", { p_session_id: call.sessionId, p_token: "other-request" });

    expect(await h.legEvent(operator, "call.answered", {}, id)).toMatchObject({ status: 200, outcome: "processed", claim: { attempts: 2 } });
    expect(h.session(call.sessionId).state).toBe("talking");
    const count = h.telnyx.calls.length;
    expect(await h.legEvent(operator, "call.answered", {}, id)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(h.telnyx.calls).toHaveLength(count);
    expect(h.now().getTime() - before).toBeLessThan(30_000);
  });

  it.each(["starting", "recording", "stopping", "unknown"] as const)("keeps %s capture serialized after both policies are disabled", async (observed) => {
    const { h, call, state } = await ringing();
    const session = h.session(call.sessionId) as SessionRow;
    const context = await loadRoutingContext(h.deps, session);
    const frozen = state();
    const modified: SessionRow = { ...session, metadata: toJson({ ...readMeta(session), recording: { ...frozen, recorders: [{
      id: "recorder", epoch: 0, callControlId: call.callControlId, startCommandId: "start", desired: "stopped", observed,
      startedAt: h.now().toISOString(), stoppedAt: null, error: null,
    }] } }) };
    context.recordingPolicy = { ...context.recordingPolicy!, enabled: false };
    expect(requiresRecordingLease(modified, context)).toBe(true);
  });

  it.each(["barrier", "pendingAudio"] as const)("retains the lease for pending %s after recording is disabled", async (kind) => {
    const { h, call, state } = await ringing();
    const session = h.session(call.sessionId) as SessionRow;
    const context = await loadRoutingContext(h.deps, session);
    context.recordingPolicy = { ...context.recordingPolicy!, enabled: false };
    const work = kind === "barrier" ? { action: null, deadlineAt: h.now().toISOString(), epoch: 0 }
      : { epoch: 0, readyAt: h.now().toISOString(), sourceEventId: "answer", commands: [] };
    const modified: SessionRow = { ...session, metadata: toJson({ ...readMeta(session), recording: { ...state(), [kind]: work } }) };
    expect(requiresRecordingLease(modified, context)).toBe(true);
  });

  it("uses the same frozen startup rule before recording metadata has been saved", async () => {
    const { h, call } = await ringing();
    const session = h.session(call.sessionId) as SessionRow;
    const context = await loadRoutingContext(h.deps, session);
    const metadata = { ...readMeta(session) };
    delete metadata.recording;
    expect(requiresRecordingLease({ ...session, metadata: toJson(metadata) }, context)).toBe(false);
    expect(requiresRecordingLease({ ...session, direction: "internal", metadata: toJson(metadata) }, context)).toBe(false);
  });
});
