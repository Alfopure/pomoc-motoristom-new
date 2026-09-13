import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, type TelephonyHarness } from "@/test/telephony-harness";
import { sessionOwnership, type Ownership } from "./ownership";
import { loadRoutingContext, runSessionEvent } from "./session-runner";
import { parseTelnyxEnvelope } from "./state/events";
import { readMeta, type SessionRow } from "./state/types";

afterEach(() => vi.restoreAllMocks());

function owned(h: TelephonyHarness, sessionId: string): Ownership {
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  h.db.registerRpc("motorist_provider_termination_legs_v2", () => []);
  h.db.registerRpc("motorist_provider_termination_checkpoint_v2", () => ({ pending: false }));
  h.db.registerRpc("motorist_provider_pending_commands_v2", () => []);
  h.db.registerRpc("motorist_provider_observe_dial_v2", () => false);
  const row = h.db.storage("motorist_call_sessions").find(row => row.id === sessionId)!;
  row.writer_contract = 2;
  row.termination_requested_at = h.now().toISOString();
  return { admin: h.admin, organizationId: h.deps.organizationId, sessionId,
    token: "termination-owner", generation: 1, contract: 2, deadline: Date.now() + 24_000 };
}

describe("priority call termination", () => {
  it("does not load fresh routing or recording configuration before an explicit hangup", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ answer: false });
    const session = h.session(call.sessionId) as SessionRow;
    h.db.log.length = 0;
    const context = await loadRoutingContext(h.deps, session, {
      kind: "app", type: "hangup", id: "hangup", actorProfileId: null, occurredAt: h.now().toISOString(),
    });
    expect(h.db.log).toEqual([]);
    expect(context.recordingPolicy).toEqual(readMeta(session).recording?.policy);
    expect(context.mediaAvailable).toBe(false);
  });

  it("resumes a committed stop on the next sweep and hangs up the non-journalled inbound customer", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    h.db.failNext("motorist_telephony_settings", "select", "routing unavailable");
    const result = await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, {
      kind: "app", type: "sweep", id: "next-owner", actorProfileId: null, occurredAt: h.now().toISOString(),
    }));
    expect(result).toMatchObject({ outcome: "applied", apply: { failed: false } });
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(readMeta(h.session(call.sessionId) as SessionRow).hangup?.scope).toBe("session");
  });

  it("still records the exact original hangup fact after resuming the durable stop", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    const event = parseTelnyxEnvelope(h.envelope("call.hangup", {
      call_control_id: call.callControlId, hangup_cause: "normal_clearing",
    }, "provider-hangup"))!;
    await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, event));
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
    expect(h.rows("motorist_call_events").some(row => row.event_fingerprint === event.id)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
  });
});
