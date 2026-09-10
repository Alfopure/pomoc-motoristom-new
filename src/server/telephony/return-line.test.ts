import { describe, expect, it } from "vitest";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PLAN_ID, PROFILES } from "@/test/telephony-harness";
import { updateTelephonyLine } from "./config-service";

const actor = { profileId: PROFILES.o4, role: "manager" as const };

describe("business return line", () => {
  it("uses the main line's greeting and group while retaining the number dialed by the caller", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    h.db.update("motorist_telephony_lines", { metadata: { return_line_id: LINES.neutral }, ring_plan_id: null }, row => row.id === LINES.allianz);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(call.results.every(result => result.status === 200)).toBe(true);
    expect(h.session(call.sessionId)).toMatchObject({ line_id: LINES.neutral, ring_plan_id: PLAN_ID, called_number: NUMBERS.allianz, metadata: { return_routing: { source_line_id: LINES.allianz, target_line_id: LINES.neutral } } });
    expect(h.telnyx.of("playbackStart").length + h.telnyx.of("speak").length).toBeGreaterThan(0);
    expect(h.attempts(call.sessionId).some(attempt => attempt.profile_id === PROFILES.o1)).toBe(true);
    expect(h.telnyx.of("dial").some(call => call.params.to === NUMBERS.neutral)).toBe(false);
  });

  it.each(["empty", "inactive", "loop", "environment", "foreign"])("refuses a %s destination before creating an unrouted call", async problem => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { metadata: { return_line_id: LINES.neutral } }, row => row.id === LINES.allianz);
    if (problem === "empty") h.db.update("motorist_telephony_lines", { ring_plan_id: null }, row => row.id === LINES.neutral);
    if (problem === "inactive") h.db.update("motorist_telephony_lines", { active: false }, row => row.id === LINES.neutral);
    if (problem === "loop") h.db.update("motorist_telephony_lines", { metadata: { return_line_id: LINES.allianz } }, row => row.id === LINES.neutral);
    if (problem === "environment") h.db.update("motorist_telephony_lines", { environment: "development" }, row => row.id === LINES.neutral);
    if (problem === "foreign") h.db.update("motorist_telephony_lines", { organization_id: "another-org" }, row => row.id === LINES.neutral);
    const result = await h.process(h.envelope("call.initiated", { call_control_id: "return-cc", call_session_id: "return-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }));
    expect(result).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("persists and audits an explicit internal route while preserving announcement metadata", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { metadata: { custom_setting: "preserve" } }, row => row.id === LINES.allianz);
    const result = await updateTelephonyLine({ admin: h.admin }, { organizationId: ORG, actor, lineId: LINES.allianz, patch: { returnLineId: LINES.neutral } });
    expect(result.line.returnLineId).toBe(LINES.neutral);
    expect(h.rows("motorist_telephony_lines").find(row => row.id === LINES.allianz)?.metadata).toMatchObject({ custom_setting: "preserve", return_line_id: LINES.neutral });
    await expect(updateTelephonyLine({ admin: h.admin }, { organizationId: ORG, actor, lineId: LINES.neutral, patch: { returnLineId: LINES.allianz } })).rejects.toThrow(/sama na seba|návratovú linku/);
    await expect(updateTelephonyLine({ admin: h.admin }, { organizationId: ORG, actor, lineId: LINES.neutral, patch: { active: false } })).rejects.toThrow(/aktívna/);
    await updateTelephonyLine({ admin: h.admin }, { organizationId: ORG, actor, lineId: LINES.allianz, patch: { returnLineId: null } });
    expect(h.rows("motorist_telephony_lines").find(row => row.id === LINES.allianz)?.metadata).toMatchObject({ return_line_id: null });
  });
});
