import { describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, startOutboundCall } from "./call-actions";
import { reconcileBrowserCall } from "./call-reconciliation";
import { TelnyxCommandError } from "./telnyx/client";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

async function talking() {
  const h = createTelephonyHarness();
  const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { to: "+421905123456" });
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  await h.legEvent("cc-2", "call.answered", { direction: "outgoing" });
  expect(h.session(call.sessionId).state).toBe("talking");
  return { h, call };
}

describe("browser leg reconciliation", () => {
  it("releases a stuck operator immediately when Telnyx confirms their browser leg ended", async () => {
    const { h, call } = await talking();
    h.telnyx.setCallStatus(call.operatorLegCallControlId, { alive: false });

    expect(await reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId))
      .toMatchObject({ reconciled: true, state: "waiting" });
    expect(h.presence(actor.profileId)).toMatchObject({ status: "after_call_work", current_session_id: null });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.operatorLegCallControlId)?.ended_at).toBeTruthy();
    expect(h.telnyx.of("retrieveCall").map(entry => entry.params.callControlId)).toEqual([call.operatorLegCallControlId]);
    expect(h.telnyx.of("hangup").some(entry => entry.params.callControlId === "cc-2")).toBe(false);

    const history = h.rows("motorist_operator_statuses");
    expect(await reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId))
      .toMatchObject({ reconciled: false, reason: "already_ended" });
    expect(h.rows("motorist_operator_statuses")).toEqual(history);
    expect(h.telnyx.of("retrieveCall")).toHaveLength(1);
  });

  it.each(["alive", "unknown", "missing_liveness"])("preserves the call for provider result %s", async scenario => {
    const { h, call } = await talking();
    if (scenario === "unknown") h.telnyx.setCallStatus(call.operatorLegCallControlId, { alive: false, known: false });
    if (scenario === "missing_liveness") vi.spyOn(h.telnyx.client, "retrieveCall").mockResolvedValue({ callControlId: call.operatorLegCallControlId, known: true, alive: false, callSessionId: null, raw: {} });
    const presence = h.presence(actor.profileId);
    const session = h.session(call.sessionId);

    expect(await reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId))
      .toMatchObject({ reconciled: false, reason: scenario === "alive" ? "alive" : "provider_unknown" });
    expect(h.session(call.sessionId)).toEqual(session);
    expect(h.presence(actor.profileId)).toEqual(presence);
  });

  it("propagates a provider outage without changing session or presence", async () => {
    const { h, call } = await talking();
    h.telnyx.failNext("retrieveCall", new TelnyxCommandError({ code: "unavailable", status: 503 }));
    const presence = h.presence(actor.profileId);
    await expect(reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId)).rejects.toMatchObject({ status: 503 });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.presence(actor.profileId)).toEqual(presence);
  });

  it.each(["other_actor", "other_org", "other_session", "customer_leg"])("rejects %s before contacting Telnyx", async scenario => {
    const { h, call } = await talking();
    const deps = scenario === "other_org" ? { ...h.deps, organizationId: "00000000-0000-4000-8000-000000009999" } : h.deps;
    const requestActor = scenario === "other_actor" ? { profileId: PROFILES.o2, role: "admin" as const } : actor;
    const sessionId = scenario === "other_session" ? String(h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "talking" })[0].id) : call.sessionId;
    await expect(reconcileBrowserCall(deps, requestActor, sessionId, scenario === "customer_leg" ? "cc-2" : call.operatorLegCallControlId))
      .rejects.toMatchObject({ status: 404, code: "leg_not_found" });
    expect(h.telnyx.of("retrieveCall")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("ignores a terminal session without contacting the provider", async () => {
    const { h, call } = await talking();
    await h.legEvent("cc-2", "call.hangup");
    await h.legEvent(call.operatorLegCallControlId, "call.hangup");
    expect(await reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId))
      .toMatchObject({ reconciled: false, state: "ended", reason: "already_terminal" });
    expect(h.telnyx.of("retrieveCall")).toHaveLength(0);
  });

  it("keeps a replacement device connected when the old device reports its ended leg", async () => {
    const { h, call } = await talking();
    const original = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.operatorLegCallControlId)!;
    h.db.insert("motorist_call_legs", { ...original, id: undefined, telnyx_call_control_id: "replacement-leg", telnyx_call_leg_id: "replacement-provider-leg", ended_at: null });
    h.db.update("motorist_call_sessions", { metadata: { ...(h.session(call.sessionId).metadata as object), answered_leg_call_control_id: "replacement-leg", accepted_device_legs: { [actor.profileId]: "replacement-leg" } } }, row => row.id === call.sessionId);
    h.telnyx.setCallStatus(call.operatorLegCallControlId, { alive: false });
    const presence = h.presence(actor.profileId);

    expect(await reconcileBrowserCall(h.deps, actor, call.sessionId, call.operatorLegCallControlId)).toMatchObject({ state: "talking", reconciled: true });
    expect(h.presence(actor.profileId)).toEqual(presence);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === "replacement-leg")?.ended_at).toBeNull();
    expect(h.telnyx.of("hangup")).toHaveLength(0);
  });

  it.each([undefined, "", " ", 42])("rejects invalid browser leg identifier %s", async callControlId => {
    const h = createTelephonyHarness();
    await expect(reconcileBrowserCall(h.deps, actor, "00000000-0000-4000-8000-000000009999", callControlId))
      .rejects.toMatchObject({ status: 400, code: "invalid_call_control_id" });
    expect(h.telnyx.calls).toHaveLength(0);
  });
});
