import { describe, expect, it } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, startOutboundCall, type CallActor } from "./call-actions";
const actor: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Operator" };
describe("outbound directory target enforcement", () => {
  it("rejects blocked or unconfirmed alternate before any session/provider call", async () => {
    for (const status of ["blocked", "verified_alternative"]) {
      const h = createTelephonyHarness();
      h.db.registerRpc("motorist_resolve_callback_target", () => ({ originalNumber: NUMBERS.customer, dialNumber: NUMBERS.customer, status, verificationId: "current" }));
      const deps = { ...h.deps, rateLimiter: createRateLimiter() };
      await expect(startOutboundCall(deps, actor, { to: NUMBERS.customer })).rejects.toMatchObject({ code: "callback_target_confirmation_required" });
      expect(h.db.rows("motorist_call_sessions")).toHaveLength(0);
      expect(h.telnyx.calls).toHaveLength(0);
    }
  });
  it("dials the approved current target while retaining original resolver input", async () => {
    const h = createTelephonyHarness();
    h.db.registerRpc("motorist_resolve_callback_target", args => ({ originalNumber: args.p_number, dialNumber: NUMBERS.customer, status: "verified_alternative", verificationId: "current" }));
    const result = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { to: "+421232408700", callbackTargetVerificationId: "current" });
    expect(result.to).toBe(NUMBERS.customer);
    expect(h.db.rows("motorist_call_sessions")[0].called_number).toBe(NUMBERS.customer);
    expect(h.db.log.find(row => row.table === "motorist_resolve_callback_target")?.payload).toMatchObject({ p_number: "+421232408700" });
  });
});
