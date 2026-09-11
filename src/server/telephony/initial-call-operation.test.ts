import { describe, expect, it } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { startOutboundCall, createRateLimiter, type CallActor } from "./call-actions";
import { initialOperationIdentity } from "./initial-call-operation";

const actor: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Operator" };
const requestId = "00000000-0000-4000-8000-000000000991";
const sessionId = "00000000-0000-4000-8000-000000000992";
const input = { to: NUMBERS.customer, requestId };

function prepared() {
  const h = createTelephonyHarness();
  let record: unknown = null;
  let generation = 0;
  h.db.registerRpc("motorist_session_lease_acquire_v2", () => ({ generation: ++generation, contract: 2 }));
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  h.db.registerRpc("motorist_session_lease_release_v2", () => true);
  h.db.registerRpc("motorist_provider_command_lookup_v2", () => record);
  h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: h.deps.organizationId, writer_contract: 2,
    direction: "outbound", state: "received", answered_by_profile_id: actor.profileId, caller_number: NUMBERS.allianz,
    called_number: NUMBERS.customer, metadata: { outbound: { to: NUMBERS.customer, from: NUMBERS.allianz, by: actor.profileId },
      initial_operation: { ...initialOperationIdentity(actor, "outbound", input), to: NUMBERS.customer, from: NUMBERS.allianz,
        sipUri: "sip:gencred001@sip.telnyx.com", fromDisplayName: "Frozen name", request: input } } }]);
  const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  return { h, deps, setRecord: (next: unknown) => { record = next; } };
}

describe("initial call operation recovery", () => {
  it("recovers a crash before provider dispatch from the exact frozen session/plan", async () => {
    const { h, deps } = prepared();
    h.db.failNext("motorist_telephony_settings", "select", "live preflight must not run again");
    const result = await startOutboundCall(deps, actor, input);
    expect(result.sessionId).toBe(sessionId);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(1);
    expect(h.telnyx.of("dial")[0].params).toMatchObject({ to: "sip:gencred001@sip.telnyx.com", fromDisplayName: "Frozen name" });
  });

  it("returns the accepted result on HTTP retry before reservation/state validation", async () => {
    const { h, deps, setRecord } = prepared();
    setRecord({ outcome: "accepted", result: { data: { call_control_id: "already-accepted", call_session_id: "provider-session" } } });
    h.db.failNext("motorist_operator_presence", "select", "operator may now be on the original call");
    const result = await startOutboundCall(deps, actor, input);
    expect(result).toMatchObject({ sessionId, operatorLegCallControlId: "already-accepted" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
  });

  it("keeps unknown startup pending without creating another session or leg", async () => {
    const { h, deps, setRecord } = prepared();
    setRecord({ outcome: "unknown" });
    await expect(startOutboundCall(deps, actor, input)).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.session(sessionId).ended_at).toBeNull();
  });

  it("rejects request reuse with a changed payload before any provider command", async () => {
    const { h, deps } = prepared();
    await expect(startOutboundCall(deps, actor, { ...input, to: "+421900000099" })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
  });
});
