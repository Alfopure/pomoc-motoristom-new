import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeCallAnnouncements, completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer, callColleague } from "../call-actions";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());
function world(recording: boolean) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness();
  if (recording) {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  }
  return h;
}
async function providerAnswer(h: TelephonyHarness, id: string) {
  h.telnyx.physical.answered(id);
  await h.legEvent(id, "call.answered");
}

describe("PA-04 physical topology before owned answer arbitration", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])("internal callee requires guarded answer (recording=%s, pause=%s)", async (recording, pause) => {
    const h = world(recording);
    const call = await callColleague(h.deps, actor, { targetProfileId: PROFILES.o2 });
    const caller = call.operatorLegCallControlId!;
    await providerAnswer(h, caller);
    const callee = String(h.legFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    if (pause) h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    // The actual provider answer precedes its webhook. A pre-armed bridge
    // would already connect these two legs here, even with zero later commands.
    h.telnyx.physical.answered(callee);
    expect(h.telnyx.physical.connected(caller, callee)).toBe(false);
    await h.legEvent(callee, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.physical.connected(caller, callee)).toBe(!pause);
    expect(h.presence(PROFILES.o2).status).toBe(pause ? "paused" : "on_call");
  });
  it.each([[false, false, false], [false, true, false], [true, false, false], [true, true, false], [false, false, true], [false, true, true], [true, false, true], [true, true, true]])("owned blind transfer requires guarded answer (recording=%s, pause=%s, PSTN=%s)", async (recording, pause, mobile) => {
    const h = world(recording);
    const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await providerAnswer(h, operator); await completeCallAnnouncements(h, call.sessionId);
    for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    h.setPresence(PROFILES.o2, { status: "available", current_session_id: null });
    if (mobile) {
      h.db.insert("motorist_operator_telephony_settings", { organization_id: ORG, profile_id: PROFILES.o2, default_mobile_number: "+421911222333" });
      h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);
    }
    await completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, mobile ? { number: "+421911222333" } : { profileId: PROFILES.o2 }));
    const target = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    if (pause) h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    h.telnyx.physical.answered(target);
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(false);
    await h.legEvent(target, "call.answered"); await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(!pause);
    expect(h.presence(PROFILES.o2).status).toBe(pause ? "paused" : "on_call");
  });
});
