import { describe, expect, it } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { pickupWaitingCall } from "./call-actions";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

async function ringingOnBackup() {
  const h = createTelephonyHarness();
  for (const profileId of Object.values(PROFILES)) h.setPresence(profileId, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz });
  expect(h.session(call.sessionId).state).toBe("ringing");
  const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
  expect(backup).toBeTruthy();
  h.setPresence(PROFILES.o1, { status: "available" });
  return { h, call, backupId: String(backup.telnyx_call_control_id) };
}

describe("manual pickup during inbound ringing", () => {
  it("lets an available browser rescue the caller from external ringing and cancels the backup only after answer", async () => {
    const { h, call, backupId } = await ringingOnBackup();
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    expect(picked.operatorLegCallControlId).toBeTruthy();
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    expect(h.telnyx.of("dial").at(-1)?.params).toMatchObject({ linkTo: call.callControlId, customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] });
    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: actor.profileId });
    expect(h.telnyx.of("bridge").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, targetCallControlId: picked.operatorLegCallControlId });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(backupId);
    await h.legEvent(backupId, "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("does not create a second pickup leg for repeated requests", async () => {
    const { h, call } = await ringingOnBackup();
    await pickupWaitingCall(h.deps, actor, call.sessionId);
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 409 });
    h.setPresence(PROFILES.o2, { status: "available" });
    await expect(pickupWaitingCall(h.deps, { ...actor, profileId: PROFILES.o2 }, call.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(h.telnyx.of("dial")).toHaveLength(2);
  });

  it("keeps the caller and backup ringing when the browser dial fails, then allows retry", async () => {
    const { h, call } = await ringingOnBackup();
    h.telnyx.failNext("dial", "browser unavailable");
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", metadata: { pickup: null } });
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    expect((await pickupWaitingCall(h.deps, actor, call.sessionId)).operatorLegCallControlId).toBeTruthy();
  });

  it("lets an external answer win the race with manual pickup without bridging twice", async () => {
    const { h, call, backupId } = await ringingOnBackup();
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    await h.legEvent(backupId, "call.answered");
    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: null, metadata: { pickup: null } });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("bridge")[0].params.targetCallControlId).toBe(backupId);
  });

  it("rejects unavailable operators and already connected calls without dialing", async () => {
    const { h, call, backupId } = await ringingOnBackup();
    h.setPresence(actor.profileId, { status: "paused" });
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 409, code: "operator_unavailable" });
    h.setPresence(actor.profileId, { status: "available" });
    await h.legEvent(backupId, "call.answered");
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });
});
