import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { getWebphoneOfferStatus, readWebphoneOfferStatusQuery } from "./webphone-offer-status";

const lease = "00000000-0000-4000-8000-000000000071";
const sessionId = "00000000-0000-4000-8000-000000000072";
const legId = "00000000-0000-4000-8000-000000000073";
function fixture() {
  const h = createTelephonyHarness();
  h.db.update("motorist_operator_devices", { device_session_id: lease, sip_username: "own-web" }, row => row.profile_id === PROFILES.o1);
  h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: ORG, direction: "inbound", state: "ringing", metadata: { environment: "development" }, ended_at: null }]);
  h.db.seed("motorist_call_legs", [{ id: legId, session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1, role: "operator", to_number: "sip:own-web@sip.telnyx.com", telnyx_call_control_id: "own-exact", ended_at: null, answered_at: null, client_state: { intent: "ring" } }]);
  const read = () => getWebphoneOfferStatus(h.deps, PROFILES.o1, { deviceSessionId: lease, callControlId: "own-exact" });
  return { h, read };
}
describe("browser own exact leg status", () => {
  it("reports own persisted ringing and delayed persistence without provider IO", async () => {
    const { h, read } = fixture();
    expect(await read()).toEqual({ callControlId: "own-exact", sessionId, status: "ringing" });
    h.db.delete("motorist_call_legs", () => true);
    expect(await read()).toEqual({ callControlId: "own-exact", sessionId: null, status: "pending" });
    expect(h.telnyx.calls).toHaveLength(0);
  });
  it.each(["inbound", "internal"])("reports another accepted device as superseded for %s", async direction => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { direction, state: "talking", metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "native-winner" } } }, () => true);
    h.db.seed("motorist_call_legs", [{ id: "winner", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1,
      role: "operator", telnyx_call_control_id: "native-winner", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: "ring" } }]);
    expect((await read()).status).toBe("superseded");
    h.db.update("motorist_call_legs", { answered_at: h.now().toISOString() }, row => row.id === legId);
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "own-exact" } } }, () => true);
    expect((await read()).status).toBe("connected");
  });
  it.each([["ring", "pickup"], ["pickup", "ring"]])("settles inbound %s against an accepted %s winner", async (intent, winningIntent) => {
    const { h, read } = fixture();
    h.db.update("motorist_call_legs", { client_state: { intent } }, () => true);
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "winner" } } }, () => true);
    h.db.seed("motorist_call_legs", [{ id: "winner", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1,
      role: "operator", telnyx_call_control_id: "winner", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: winningIntent } }]);
    expect((await read()).status).toBe("superseded");
  });
  it("checks the inbound global winner independently of another accepted invitation", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "consult" }, answered_leg_call_control_id: "customer-winner" } }, () => true);
    h.db.seed("motorist_call_legs", [
      { id: "consult", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1, role: "operator", telnyx_call_control_id: "consult", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: "consult" } },
      { id: "winner", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o2, role: "operator", telnyx_call_control_id: "customer-winner", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: "pickup" } },
    ]);
    expect((await read()).status).toBe("superseded");
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, row => row.id === "winner");
    expect((await read()).status).toBe("ringing");
  });
  it("settles an explicitly re-offered mobile transfer only against its exact source", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_call_legs", { client_state: { intent: "transfer" } }, () => true);
    const metadata = { environment: "development", accepted_device_legs: { [PROFILES.o1]: "winner" }, mobile_offers: { [PROFILES.o1]: { source: "own-exact", at: h.now().toISOString() } } };
    h.db.update("motorist_call_sessions", { metadata }, () => true);
    h.db.seed("motorist_call_legs", [{ id: "winner", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1,
      role: "operator", telnyx_call_control_id: "winner", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: "transfer_recorded" } }]);
    expect((await read()).status).toBe("superseded");
    h.db.update("motorist_call_sessions", { metadata: { ...metadata, mobile_offers: { [PROFILES.o1]: { source: "another-transfer", at: h.now().toISOString() } } } }, () => true);
    expect((await read()).status).toBe("ringing");
    h.db.update("motorist_call_sessions", { metadata }, () => true);
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, row => row.id === "winner");
    expect((await read()).status).toBe("ringing");
  });
  it("does not supersede a re-offer from stale accepted metadata whose winner ended", async () => {
    const { h, read } = fixture();
    h.db.seed("motorist_call_legs", [{ id: "old", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o1,
      role: "operator", telnyx_call_control_id: "old-winner", answered_at: h.now().toISOString(), ended_at: h.now().toISOString() }]);
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "old-winner" } } }, () => true);
    expect((await read()).status).toBe("ringing");
  });
  it.each(["missing", "unanswered", "foreign-session", "foreign-profile", "other-invitation"])("does not trust %s accepted winner metadata", async kind => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", accepted_device_legs: { [PROFILES.o1]: "winner" } } }, () => true);
    if (kind !== "missing") h.db.seed("motorist_call_legs", [{ id: "winner", session_id: kind === "foreign-session" ? "other" : sessionId,
      organization_id: ORG, profile_id: kind === "foreign-profile" ? PROFILES.o2 : PROFILES.o1, role: "operator", telnyx_call_control_id: "winner",
      answered_at: kind === "unanswered" ? null : h.now().toISOString(), ended_at: null, client_state: { intent: kind === "other-invitation" ? "party" : "ring" } }]);
    expect((await read()).status).toBe("ringing");
  });
  it("does not classify the internal caller as a loser of its colleague", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { direction: "internal", state: "talking", answered_by_profile_id: PROFILES.o1, metadata: { environment: "development", accepted_device_legs: { [PROFILES.o2]: "callee" } } }, () => true);
    h.db.update("motorist_call_legs", { answered_at: h.now().toISOString(), client_state: { intent: "internal_caller" } }, () => true);
    expect((await read()).status).toBe("connected");
  });
  it("uses inbound answered-leg only for ordinary inbound offers, not conference participants", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { state: "talking", metadata: { environment: "development", answered_leg_call_control_id: "other-profile" } }, () => true);
    h.db.seed("motorist_call_legs", [{ id: "winner", session_id: sessionId, organization_id: ORG, profile_id: PROFILES.o2,
      role: "operator", telnyx_call_control_id: "other-profile", answered_at: h.now().toISOString(), ended_at: null, client_state: { intent: "ring" } }]);
    expect((await read()).status).toBe("superseded");
    h.db.update("motorist_call_legs", { client_state: { intent: "party" }, answered_at: h.now().toISOString() }, () => true);
    expect((await read()).status).toBe("ringing");
  });
  it.each(["leg", "session", "termination"])("definitively ends an owned %s", async target => {
    const { h, read } = fixture();
    if (target === "leg") h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, () => true);
    else h.db.update("motorist_call_sessions", { [target === "session" ? "ended_at" : "termination_requested_at"]: h.now().toISOString() }, () => true);
    expect((await read()).status).toBe("ended");
  });
  it.each(["lease", "sip", "environment"])("rejects a foreign %s without terminal inference", async kind => {
    const { h, read } = fixture();
    if (kind === "lease") h.db.update("motorist_operator_devices", { device_session_id: "different" }, () => true);
    if (kind === "sip") h.db.update("motorist_call_legs", { to_number: "sip:native@sip.telnyx.com" }, () => true);
    if (kind === "environment") h.db.update("motorist_call_sessions", { metadata: { environment: "production" } }, () => true);
    await expect(read()).rejects.toMatchObject({ status: kind === "lease" ? 409 : 403 });
  });
  it.each(["motorist_operator_devices", "motorist_call_legs", "motorist_call_sessions"])("does not turn a %s read failure into ended", async table => {
    const { h, read } = fixture(); h.db.failNext(table, "select", "unavailable");
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
  it("does not expose another organization or profile's session", async () => {
    const { h, read } = fixture(); h.db.update("motorist_call_legs", { profile_id: PROFILES.o2 }, () => true);
    expect(await read()).toMatchObject({ sessionId: null, status: "pending" });
    h.db.update("motorist_call_legs", { profile_id: PROFILES.o1, organization_id: "foreign" }, () => true);
    expect(await read()).toMatchObject({ sessionId: null, status: "pending" });
  });
  it.each(["", `deviceSessionId=${lease}`, `deviceSessionId=x&callControlId=own`, `deviceSessionId=${lease}&callControlId=`, `deviceSessionId=${lease}&callControlId=a&callControlId=b`, `deviceSessionId=${lease}&callControlId=a&profileId=spoof`])("rejects malformed query %s", query => {
    expect(() => readWebphoneOfferStatusQuery(new URLSearchParams(query))).toThrow();
  });
});
