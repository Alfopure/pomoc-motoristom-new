import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, hangupCall, startOutboundCall } from "../call-actions";
import { readContactHistory } from "../contact-proof";
import { readMeta, type SessionRow } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());

async function outbound() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness();
  const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  const call = await startOutboundCall(deps, actor, { to: NUMBERS.customer });
  const operator = call.operatorLegCallControlId;
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  const customer = String(h.legs(call.sessionId).find((leg) => leg.role === "customer")!.telnyx_call_control_id);
  return { h, deps, call, operator, customer };
}

describe("direct outgoing provider connection", () => {
  it("keeps a legacy recorded call behind the notice when live recording changes while ringing", async () => {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
    const h = createTelephonyHarness();
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, recording_enabled: false,
      approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { to: NUMBERS.customer });
    const announcements = defaultAnnouncementConfig();
    delete announcements.outboundStartAnnouncements;
    h.db.update("motorist_call_sessions", { metadata: { ...readMeta(h.session(call.sessionId) as SessionRow), announcements,
      recording: { version: 1, epoch: 0, policy: { enabled: true, inbound: true, outbound: true, policyId: "legacy",
        noticeVersion: "recording-notice-v2", maxSegmentSeconds: 1800 }, noticeCompletedAt: null, noticeFailed: false,
        suppressedAt: null, suppressionReason: null, recorders: [], error: null } } }, (row) => row.id === call.sessionId);
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = String(h.legs(call.sessionId).find((leg) => leg.role === "customer")!.telnyx_call_control_id);

    expect(h.telnyx.of("dial")[1].params.bridgeOnAnswer).not.toBe(true);
    h.db.update("motorist_call_recording_policies", { recording_enabled: true }, () => true);
    h.telnyx.physical.answered(customer);
    expect(h.telnyx.physical.connected(call.operatorLegCallControlId, customer)).toBe(false);
    await h.legEvent(customer, "call.answered");

    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.keys).toEqual(["recordingServiceNotice"]);
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
    expect(h.telnyx.physical.connected(call.operatorLegCallControlId, customer)).toBe(false);
  });

  it("connects physically on customer answer before any answer or bridge webhook is delivered", async () => {
    const { h, call, operator, customer } = await outbound();
    expect(h.telnyx.of("dial")[1].params).toMatchObject({ bridgeOnAnswer: true, preventDoubleBridge: true, linkTo: operator, extra: { park_after_unbridge: "self" } });
    expect(h.telnyx.physical.connected(operator, customer)).toBe(false);
    const commandsBefore = h.telnyx.calls.length;

    h.telnyx.physical.answered(customer);

    expect(h.telnyx.physical.connected(operator, customer)).toBe(true);
    expect(h.telnyx.calls).toHaveLength(commandsBefore);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("createConference")).toHaveLength(0);
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(0);
  });

  it.each(["customer", "operator"] as const)("requires both correlated bridged events with %s delivered first", async (first) => {
    const { h, call, operator, customer } = await outbound();
    h.telnyx.physical.answered(customer);
    await h.legEvent(customer, "call.answered");
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(0);
    await h.legEvent(first === "customer" ? customer : operator, "call.bridged");
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(0);
    await h.legEvent(first === "customer" ? operator : customer, "call.bridged");
    const history = readContactHistory(h.session(call.sessionId) as SessionRow);
    expect(history.proofs).toMatchObject([{ topology: "bridge", customerControlId: customer, operatorControlId: operator }]);
    expect(history.operations[0].id).toBe(readMeta(h.session(call.sessionId) as SessionRow).outbound_auto_bridge?.commandId);
    await h.legEvent(customer, "call.bridged");
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("does not connect after the operator cancels before the recipient answers", async () => {
    const { h, deps, call, operator, customer } = await outbound();
    await hangupCall(deps, actor, call.sessionId);
    h.telnyx.physical.answered(customer);
    await h.legEvent(customer, "call.answered");
    expect(h.telnyx.physical.connected(operator, customer)).toBe(false);
    expect(h.telnyx.physical.legs.get(customer)?.ended).toBe(true);
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(0);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("recovers the same provider dial and contact identity when its response is lost", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { to: NUMBERS.customer });
    const operator = call.operatorLegCallControlId;
    h.telnyx.physical.answered(operator);
    h.telnyx.loseNextResponse("dial");
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("failed");
    const dial = h.telnyx.of("dial")[1];
    const customer = [...h.telnyx.physical.legs.keys()].find((id) => id !== operator)!;
    expect(h.legs(call.sessionId).some((leg) => leg.role === "customer")).toBe(false);
    h.telnyx.physical.answered(customer);
    expect(h.telnyx.physical.connected(operator, customer)).toBe(true);

    const recovered = await h.process(h.envelope("call.bridged", { call_control_id: customer, call_leg_id: `leg-${customer}`,
      client_state: dial.params.clientState, to: NUMBERS.customer, from: NUMBERS.allianz, direction: "outgoing" }));

    expect(recovered.outcome).toBe("processed");
    await h.legEvent(operator, "call.bridged");
    expect(h.telnyx.physical.legs.size).toBe(2);
    expect(h.telnyx.of("dial")[2].params.commandId).toBe(dial.params.commandId);
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("retains contact identity when the operator answer arrives before its dial response is saved", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { to: NUMBERS.customer });
    const operator = call.operatorLegCallControlId;
    const ownDial = h.telnyx.of("dial")[0];
    h.db.delete("motorist_call_legs", (leg) => leg.telnyx_call_control_id === operator);
    const result = await h.process(h.envelope("call.answered", { call_control_id: operator, call_leg_id: `leg-${operator}`,
      client_state: ownDial.params.clientState, to: ownDial.params.to, from: ownDial.params.from, direction: "outgoing" }));
    expect(result.outcome).toBe("processed");
    const customer = String(h.legs(call.sessionId).find((leg) => leg.role === "customer")!.telnyx_call_control_id);
    await h.legEvent(customer, "call.bridged");
    await h.legEvent(operator, "call.bridged");
    expect(readContactHistory(h.session(call.sessionId) as SessionRow).proofs).toHaveLength(1);
  });
});
