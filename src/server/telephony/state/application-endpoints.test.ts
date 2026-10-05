import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { TelnyxCommandError } from "../telnyx/client";

afterEach(() => vi.unstubAllEnvs());
function world() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: { version: 1, ending: "hangup", steps: [
    { id: "00000000-0000-4000-8000-000000009001", type: "ring", seconds: 30,
      people: [{ profileId: PROFILES.o1, application: true, personalNumber: NUMBERS.external }] },
  ] } } }, row => row.id === LINES.allianz);
  h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o1, environment: "development", sip_username: "mobile-o1", telnyx_credential_id: "mobile-o1", device_session_id: "mobile-session", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
  return h;
}
function endpoints(h: TelephonyHarness, id: string) {
  const legs = h.legs(id).filter(leg => leg.profile_id === PROFILES.o1);
  return Object.fromEntries(legs.map(leg => [leg.role === "external" ? "personal" : h.clientStateOf(String(leg.telnyx_call_control_id)).applicationDevice === "mobile" ? "mobile" : "web", String(leg.telnyx_call_control_id)]));
}
describe("one application choice across web and installed mobile plus personal number", () => {
  it.each(["web", "mobile", "personal"])("connects only the %s winner and independently retires the other two endpoints", async winner => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    expect(Object.keys(targets).sort()).toEqual(["mobile", "personal", "web"]);
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(new Set(h.telnyx.of("dial").map(dial => dial.params.commandId)).size).toBe(3);
    expect(new Set(h.attempts(call.sessionId).map(attempt => attempt.leg_id)).size).toBe(3);
    expect(new Set(Object.values(targets).map(id => h.clientStateOf(id).offerToken)).size).toBe(1);
    for (const id of Object.values(targets)) h.telnyx.physical.answered(id);
    await h.legEvent(targets[winner], "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, targets[winner])).toBe(true);
    for (const [name, id] of Object.entries(targets)) {
      if (name === winner) continue;
      expect(h.telnyx.physical.legs.get(id)?.ended).toBe(true);
      await h.legEvent(id, "call.answered");
      await h.legEvent(id, "call.hangup", { hangup_cause: "normal_clearing" });
    }
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.physical.connected(call.callControlId, targets[winner])).toBe(true);
    expect(h.attempts(call.sessionId).map(row => row.result).sort()).toEqual(["answered", "cancelled", "cancelled"]);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });
  it("a refused web dial does not mark the mobile application attempt failed or release its reservation", async () => {
    const h = world();
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "web SIP unavailable" }));
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId).find(row => row.application_device === "web")?.result).toBe("failed");
    expect(h.attempts(call.sessionId).find(row => row.application_device === "mobile")?.result).toBe("offered");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
    const mobile = endpoints(h, call.sessionId).mobile;
    h.telnyx.physical.answered(mobile);
    await h.legEvent(mobile, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, mobile)).toBe(true);
    expect(h.presence(PROFILES.o1).status).toBe("on_call");
  });
  it("ends all three offers if the caller hangs up", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    h.telnyx.physical.ended(call.callControlId);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_source: "caller", hangup_cause: "normal_clearing" });
    expect(h.attempts(call.sessionId).map(row => row.result)).toEqual(["cancelled", "cancelled", "cancelled"]);
    for (const id of Object.values(targets)) expect(h.telnyx.physical.legs.get(id)?.ended).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });
});
