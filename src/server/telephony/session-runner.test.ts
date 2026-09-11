import { afterEach, describe, expect, it, vi } from "vitest";

import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { fakeError } from "@/test/fake-supabase";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PLAN_ID, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { callColleague, createRateLimiter, parkCall, pickupWaitingCall, startOutboundCall } from "./call-actions";
import { loadRoutingContext } from "./session-runner";
import { readMeta, type SessionRow } from "./state/types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const deps = (h: TelephonyHarness) => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
const inboundTables = [
  "motorist_business_hours", "motorist_business_hours_intervals", "motorist_business_hours_exceptions",
  "motorist_ivr_menus", "motorist_ivr_options", "motorist_ring_plans", "motorist_ring_plan_steps",
  "motorist_ring_groups", "motorist_ring_group_members",
];

afterEach(() => vi.unstubAllEnvs());

describe("session routing setup", () => {
  it.each(["outbound", "internal"] as const)("starts the %s recipient without waiting for unrelated inbound routing", async (direction) => {
    const h = createTelephonyHarness();
    const call = direction === "outbound"
      ? await startOutboundCall(deps(h), actor, { to: NUMBERS.customer, lineId: LINES.neutral })
      : await callColleague(deps(h), actor, { targetProfileId: PROFILES.o2 });
    h.db.log.length = 0;
    for (const table of inboundTables) h.db.failNext(table, "select", fakeError("unrelated inbound routing unavailable"));

    const result = await h.legEvent(call.operatorLegCallControlId, "call.answered");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(h.telnyx.of("dial")[1].params.to).toBe(direction === "outbound" ? NUMBERS.customer : "sip:gencred002@sip.telnyx.com");
    expect(h.db.log.filter((entry) => inboundTables.includes(entry.table))).toEqual([]);
  });

  it("still resolves inbound IVR, ring plans and operator eligibility", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral, completeGreeting: false });

    const context = await loadRoutingContext(h.deps, h.session(call.sessionId) as SessionRow);

    expect(context.businessHours).not.toBeNull();
    expect(context.ivr?.options).toHaveLength(2);
    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.activeLegCount).toBe(1);
  });

  it("retains explicit saved routing when the original call was outgoing", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const session = h.session(call.sessionId) as SessionRow;
    expect(readMeta(session).ring?.plan).toBeTruthy();

    const context = await loadRoutingContext(h.deps, { ...session, direction: "outbound" });

    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map((row) => row.profile_id)).toContain(PROFILES.o1);
  });

  it.each(["ringing", "waiting", "parked"] as const)("uses the frozen plan in %s while unrelated entry routing is unavailable", async state => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const session = { ...h.session(call.sessionId), state } as SessionRow;
    h.db.log.length = 0;
    for (const table of inboundTables) h.db.failNext(table, "select", fakeError("entry routing unavailable"));

    const context = await loadRoutingContext(h.deps, session);

    expect(context.businessHours).toBeNull();
    expect(context.ivr).toBeNull();
    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map(row => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map(row => row.profile_id)).toContain(PROFILES.o1);
    expect(context.activeLegCount).toBeGreaterThan(0);
    expect(h.db.log.filter(entry => inboundTables.includes(entry.table))).toEqual([]);
    expect(h.db.log.some(entry => entry.table === "motorist_operator_telephony_settings")).toBe(true);
  });

  it("enforces capacity when another operator picks up a parked outgoing call", async () => {
    const h = createTelephonyHarness();
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = h.legs(call.sessionId).find((leg) => leg.role === "customer")!;
    await h.legEvent(String(customer.telnyx_call_control_id), "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    await completeAnnouncedAction(h, parkCall(deps(h), actor, call.sessionId));
    await h.legEvent(call.operatorLegCallControlId, "call.hangup");
    h.db.update("motorist_telephony_settings", { max_concurrent_legs: 1 }, () => true);
    const before = h.telnyx.of("dial").length;

    await expect(pickupWaitingCall(deps(h), { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId)).rejects.toThrow("Kapacita hovorov je obsadená");

    expect(h.session(call.sessionId).state).toBe("parked");
    expect(h.telnyx.of("dial")).toHaveLength(before);
  });

  it("continues to read the current recording policy for outgoing setup", async () => {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
    const h = createTelephonyHarness();
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    const session = h.session(call.sessionId) as SessionRow;

    expect((await loadRoutingContext(h.deps, session)).recordingPolicy).toMatchObject({ enabled: true, outbound: true });
    h.db.update("motorist_call_recording_policies", { recording_enabled: false }, () => true);
    expect((await loadRoutingContext(h.deps, session)).recordingPolicy?.enabled).toBe(false);
  });
});
