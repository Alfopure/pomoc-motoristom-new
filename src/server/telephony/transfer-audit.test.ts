import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { addCallParty, blindTransfer, CallActionError, createRateLimiter, type CallActionDeps, type CallActor } from "./call-actions";
import { TelnyxCommandError } from "./telnyx/client";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };

const deps = (h: TelephonyHarness): CallActionDeps => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

const auditRows = (h: TelephonyHarness, action: string) =>
  h.db.rows("motorist_audit_log").filter((row) => row.action === action);

async function fail(promise: Promise<unknown>): Promise<CallActionError> {
  try { await promise; } catch (error) {
    if (error instanceof CallActionError) return error;
    throw error;
  }
  throw new Error("expected a CallActionError");
}

/** Inbound call answered by o1 (losers hung up) → talking. */
async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  return { ...call, operatorLeg: String(winner.telnyx_call_control_id) };
}

describe("a refused destination leaves a trace", () => {
  it("records what was typed and what it became when a transfer is refused", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);

    // A German number the allowlist does not carry.
    const error = await fail(completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { number: "+49 151 12345678" })));

    expect(error.status).toBe(403);
    // The sentence names the number, so a screenshot is enough to diagnose it.
    expect(error.message).toContain("+4915112345678");
    expect(auditRows(h, "telephony.call.blind_transfer.failed")).toEqual([
      expect.objectContaining({
        entity_id: call.sessionId,
        actor_profile_id: PROFILES.o1,
        after_payload: expect.objectContaining({
          kind: "number",
          requested: "+49 151 12345678",
          dialled: "+4915112345678",
          code: "destination_not_allowed",
        }),
      }),
    ]);
  });

  it("records the country the console filled in when none was typed", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);

    // A Czech mobile in national form. Nothing in it says Czech, so it becomes
    // a Slovak number and the transfer goes through — to the wrong country,
    // silently. The row is the only place that difference survives.
    await completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { number: "0776 123 456" }));

    expect(h.telnyx.of("transfer")[0].params.to).toBe("+421776123456");
    expect(auditRows(h, "telephony.call.blind_transfer")[0]).toMatchObject({
      after_payload: { requested: "0776 123 456", dialled: "+421776123456" },
    });
  });

  it("records an add-party the provider refuses", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "destination rejected" }));

    const error = await fail(completeAnnouncedAction(h, addCallParty(deps(h), o1, call.sessionId, { number: "0900 000 000" })));

    expect(error.status).toBe(502);
    expect(auditRows(h, "telephony.conference.add_party")).toEqual([]);
    expect(auditRows(h, "telephony.conference.add_party.failed")[0]).toMatchObject({
      after_payload: { kind: "number", requested: "0900 000 000", dialled: NUMBERS.external, status: 502 },
    });
  });

  it("still records the successful transfer, with the number it dialled", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);

    await completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { number: "0900 000 000" }));

    expect(auditRows(h, "telephony.call.blind_transfer.failed")).toEqual([]);
    expect(auditRows(h, "telephony.call.blind_transfer")[0]).toMatchObject({
      after_payload: { kind: "number", requested: "0900 000 000", dialled: NUMBERS.external },
    });
  });
});
