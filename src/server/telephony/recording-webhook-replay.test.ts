import { afterEach, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { replayStalledWebhookEvents } from "./cron-jobs";
import { ownershipRpc } from "./ownership";
import { readMeta, type SessionRow } from "./state/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function recordedCall() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  for (const key of ["TELNYX_RECORDING_ENABLED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED",
    "TELNYX_RECORDING_CHANNELS_VERIFIED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness({ writerContract: 2, leaseWaitMs: 1, sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, recording_enabled: true,
    revision: 1, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
  const recorder = readMeta(h.session(call.sessionId) as SessionRow).recording!.recorders[0];
  expect(recorder.providerRecordingId).toBeTruthy();
  const enqueue = vi.fn();
  const rpc = h.admin.rpc.bind(h.admin);
  vi.spyOn(h.admin, "rpc").mockImplementation((name, args) => {
    if (name === "motorist_recording_enqueue_saved") {
      enqueue(args);
      return Promise.resolve({ data: "00000000-0000-4000-8000-000000000099", error: null }) as unknown as ReturnType<typeof rpc>;
    }
    return rpc(name, args);
  });
  const payload = { recording_id: recorder.providerRecordingId,
    recording_started_at: recorder.startedAt, recording_ended_at: new Date(h.now().getTime() + 5_000).toISOString() };
  return { h, call, recorder, enqueue, payload };
}

it("recovers a lease-busy saved recording through the real cron after its signed URL was redacted", async () => {
  const { h, call, recorder, enqueue, payload } = await recordedCall();
  await ownershipRpc(h.admin, "motorist_session_lease_acquire_v2", { p_session_id: call.sessionId, p_token: "other-host", p_ttl_ms: 15_000 });
  const id = "saved-recording-deferred";
  expect(await h.legEvent(call.callControlId, "call.recording.saved", {
    ...payload, recording_urls: { wav: "https://recordings.telnyx.com/audio?temporary=secret" },
  }, id)).toMatchObject({ outcome: "failed", error: expect.stringContaining("SessionLeaseBusyError") });
  const ledger = () => h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === id)!;
  expect(ledger()).toMatchObject({ retry_state: "deferred", effect_failure_count: 0 });
  expect(ledger().payload).not.toHaveProperty("recording_urls");
  expect(JSON.stringify(ledger())).not.toContain("temporary=secret");
  expect(enqueue).not.toHaveBeenCalled();
  await ownershipRpc(h.admin, "motorist_session_lease_release_v2", { p_session_id: call.sessionId, p_token: "other-host", p_generation: h.session(call.sessionId).ownership_generation });
  h.advance(5 * 60_000);

  expect(await replayStalledWebhookEvents(h.deps)).toMatchObject({ status: "ok", detail: { replayed: 1 } });

  expect(ledger()).toMatchObject({ status: "processed", attempts: 2, error: null });
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    p_organization_id: ORG, p_call_id: h.call(call.sessionId)!.id, p_session_id: call.sessionId,
    p_provider_recording_id: recorder.providerRecordingId,
    p_metadata: expect.objectContaining({ recorderId: recorder.id, sourceUrl: null,
      startedAt: payload.recording_started_at, endedAt: payload.recording_ended_at }),
  }));
  expect((await h.legEvent(call.callControlId, "call.recording.saved", payload, id)).outcome).toBe("duplicate");
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it("does not enqueue an unrequested provider recording even when its timestamps are valid", async () => {
  const { h, call, enqueue, payload } = await recordedCall();
  const result = await h.legEvent(call.callControlId, "call.recording.saved", { ...payload, recording_id: "unrequested-recording" });
  expect(result.outcome).toBe("processed");
  expect(enqueue).not.toHaveBeenCalled();
});

it("retains the failure for a requested recording with incomplete provider timing", async () => {
  const { h, call, enqueue, payload } = await recordedCall();
  const result = await h.legEvent(call.callControlId, "call.recording.saved", { ...payload, recording_ended_at: "invalid" });
  expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("recording saved payload incomplete") });
  expect(enqueue).not.toHaveBeenCalled();
});
