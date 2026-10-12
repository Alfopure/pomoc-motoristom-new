import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, LINES, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { readMeta, type SessionRow } from "./types";
import { materialiseLineFlow } from "../routing/line-flow";
import type { RuntimeRoutingSnapshot } from "../routing/snapshot";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function snapshot(h: TelephonyHarness) {
  return { ...Object.fromEntries(Object.entries({ lines: "motorist_telephony_lines", groups: "motorist_ring_groups", members: "motorist_ring_group_members", plans: "motorist_ring_plans", steps: "motorist_ring_plan_steps", hours: "motorist_business_hours", intervals: "motorist_business_hours_intervals", exceptions: "motorist_business_hours_exceptions", operatorSettings: "motorist_operator_telephony_settings" }).map(([key, table]) => [key, h.rows(table)])), settings: h.rows("motorist_telephony_settings")[0] } as unknown as RuntimeRoutingSnapshot;
}
function harness() {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, ivrOnNeutralLine: false });
  h.db.registerRpc("motorist_routing_snapshot", () => ({ ...snapshot(h), snapshotId: "a".repeat(32) }));
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: { version: 1, ending: "hangup", steps: [
    { id: id(1), type: "ring", seconds: 30, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] },
    { id: id(2), type: "line", lineId: LINES.neutral },
  ] } } }, row => row.id === LINES.allianz);
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: { version: 1, ending: "hangup", steps: [
    { id: id(3), type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }, { profileId: PROFILES.o2, application: true, personalNumber: null }] },
  ] } } }, row => row.id === LINES.neutral);
  return h;
}
beforeEach(() => vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
describe("internal line transfer", () => {
  it("continues one customer call on the destination with fresh offer indices", async () => {
    const h = harness(); const call = await h.inbound({ to: NUMBERS.allianz, from: NUMBERS.customer });
    const first = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(first.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
    expect(h.openLegFor(call.sessionId, PROFILES.o2)).toBeTruthy();
    expect(h.attempts(call.sessionId).map(row => row.step_index)).toEqual([0, 2, 2]);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.legs(call.sessionId).filter(row => row.role === "customer")).toHaveLength(1);
    expect(h.telnyx.of("dial").every(dial => !Object.values(NUMBERS).slice(0, 2).includes(String(dial.params.to) as typeof NUMBERS.neutral))).toBe(true);
    expect(h.session(call.sessionId).caller_number).toBe(NUMBERS.customer);
    expect(readMeta(h.session(call.sessionId) as SessionRow).routing_line_id).toBe(LINES.neutral);
    const winner = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    await h.legEvent(call.callControlId, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.telnyx.of("hangup").some(command => command.params.callControlId === winner.telnyx_call_control_id)).toBe(true);
  });
  it("respects the target's explicit flow even when the default is queue first", async () => {
    const h = harness(); h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first" }, () => true);
    const call = await h.inbound({ to: NUMBERS.allianz });
    await h.legEvent(String(h.openLegFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
    expect(h.openLegFor(call.sessionId, PROFILES.o2)).toBeTruthy();
    expect(h.session(call.sessionId).state).toBe("ringing");
  });
  it("uses the frozen destination even if its configuration changes during ringing", async () => {
    const h = harness(); const call = await h.inbound({ to: NUMBERS.allianz });
    h.db.update("motorist_telephony_lines", { metadata: {}, active: false }, row => row.id === LINES.neutral);
    await h.legEvent(String(h.openLegFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
    expect(h.openLegFor(call.sessionId, PROFILES.o2)).toBeTruthy();
  });
  it("rejects circular, foreign-environment and archived destinations before provider operations", () => {
    const h = harness(), paused = { pausedProfileIds: new Set<string>(), routing: [], destinationAllowlist: ["SK", "CZ"] };
    const raw = snapshot(h);
    const target = raw.lines.find(line => line.id === LINES.neutral)!;
    target.environment = "development";
    expect(() => materialiseLineFlow(raw, LINES.allianz, h.now(), paused)).toThrow("incoming_line_unavailable");
    target.environment = raw.lines.find(line => line.id === LINES.allianz)!.environment;
    target.metadata = { incoming_flow: { version: 1, ending: "hangup", steps: [{ id: id(9), type: "line", lineId: LINES.allianz }] } };
    expect(() => materialiseLineFlow(raw, LINES.allianz, h.now(), paused)).toThrow("incoming_line_loop");
    target.metadata = { archived_at: h.now().toISOString() };
    expect(() => materialiseLineFlow(raw, LINES.allianz, h.now(), paused)).toThrow("incoming_line_unavailable");
  });
});
