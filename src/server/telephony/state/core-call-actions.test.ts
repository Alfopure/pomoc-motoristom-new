import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { addCallParty, blindTransfer, cancelConsult, completeTransfer, holdCall, parkCall, startConsult, unholdCall } from "../call-actions";
import { readMeta, type SessionRow } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());

async function talking(recording = false) {
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const name of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(name, String(recording));
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  if (recording) h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== actor.profileId) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return { h, call, meta: () => readMeta(h.session(call.sessionId) as SessionRow) };
}

describe("immediate controls without recording", () => {
  it("dials an added participant without starting an announcement or waiting for a media webhook by default", async () => {
    const { h, call, meta } = await talking();
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", undefined);
    const before = h.telnyx.calls.length;
    const result = await addCallParty(h.deps, actor, call.sessionId, { number: NUMBERS.external });
    expect(result.commands).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "dial", ok: true })]));
    expect(h.legByNumber(call.sessionId, NUMBERS.external)).toBeTruthy();
    expect(h.telnyx.calls.slice(before).some((entry) => entry.method === "playbackStart" || entry.method === "speak")).toBe(false);
    expect(meta().announcement_sequence ?? null).toBeNull();
  });

  it("holds and resumes without a media completion", async () => {
    const { h, call, meta } = await talking();
    expect((await holdCall(h.deps, actor, call.sessionId)).state).toBe("held");
    expect(meta().announcement_sequence ?? null).toBeNull();
    expect((await unholdCall(h.deps, actor, call.sessionId)).state).toBe("talking");
    expect(meta().announcement_sequence ?? null).toBeNull();
    expect(h.telnyx.of("conference:hold")).toHaveLength(1);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(1);
  });

  it.each(["park", "blind_transfer", "consult"] as const)("executes %s in the original request", async (action) => {
    const { h, call, meta } = await talking();
    const result = action === "park" ? await parkCall(h.deps, actor, call.sessionId)
      : action === "consult" ? await startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 })
      : await blindTransfer(h.deps, actor, call.sessionId, { number: NUMBERS.external });
    expect(result.state).toBe(action === "park" ? "parked" : action === "consult" ? "consulting" : "ringing");
    expect(meta().announcement_sequence ?? null).toBeNull();
    if (action === "consult") {
      expect((await cancelConsult(h.deps, actor, call.sessionId)).state).toBe("talking");
      expect(meta().announcement_sequence ?? null).toBeNull();
    }
  });

  it("completes an answered consult without a transfer announcement", async () => {
    const { h, call, meta } = await talking();
    await startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 });
    const consult = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
    const result = await completeTransfer(h.deps, actor, call.sessionId);
    expect(result.state).toBe("talking");
    expect(h.session(call.sessionId).answered_by_profile_id).toBe(PROFILES.o2);
    expect(meta().announcement_sequence ?? null).toBeNull();
  });

  it("preserves an opted-in announcement already playing when configuration changes", async () => {
    const { h, call, meta } = await talking();
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "true");
    expect((await holdCall(h.deps, actor, call.sessionId)).state).toBe("talking");
    expect(meta().announcement_sequence?.keys).toEqual(["holdStart"]);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
    await expect(addCallParty(h.deps, actor, call.sessionId, { number: NUMBERS.external })).rejects.toMatchObject({ code: "rejected" });
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
    expect(h.telnyx.of("conference:hold")).toHaveLength(1);
  });

  it("retains the recording stop barrier even when optional prompts are disabled", async () => {
    const { h, call, meta } = await talking(true);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    const dials = h.telnyx.of("dial").length;
    h.telnyx.failAlways("recordingStop", "stop acknowledgement unavailable");
    await expect(startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(meta().recording?.recorders.some((recorder) => recorder.observed === "unknown")).toBe(true);
  });
});
