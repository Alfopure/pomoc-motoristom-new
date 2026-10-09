import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { getTelephonyHealth } from "./health";
import { runTelephonyAlerts } from "./alerts";
import { TelnyxCommandError } from "./telnyx/client";

async function connectedCall() {
  const h = createTelephonyHarness({ ivrOnNeutralLine: false });
  const call = await h.inbound();
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  const loser = h.legFor(call.sessionId, PROFILES.o2)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  await h.legEvent(call.callControlId, "call.bridged");
  await h.legEvent(String(winner.telnyx_call_control_id), "call.bridged");
  // A parallel unanswered leg ends AFTER the actual conversation connected.
  await h.legEvent(String(loser.telnyx_call_control_id), "call.hangup", {
    hangup_cause: "normal_clearing", sip_hangup_cause: "487",
  });
  expect(h.session(call.sessionId).state).toBe("talking");
  return { h, call };
}

describe("telephony alert lifecycle regressions", () => {
  it("stays quiet after simultaneous customer/operator hangups reject commands on the ended customer", async () => {
    const { h, call } = await connectedCall();
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    // Provider already ended the customer, but its hangup webhook arrives last.
    h.telnyx.physical.ended(call.callControlId);
    for (const method of ["playbackStart", "gather"]) h.telnyx.failNext(method,
      new TelnyxCommandError({ code: "90018", status: 422, detail: "This call is no longer active and can't receive commands." }));
    await h.legEvent(String(winner.telnyx_call_control_id), "call.hangup", { hangup_source: "callee", hangup_cause: "normal_clearing" });
    expect(h.rows("motorist_telnyx_webhook_events").some(event => event.status === "failed" && String(event.error).startsWith("90018(422):"))).toBe(true);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_source: "caller", hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("ended");
    // One parallel leg has not delivered its cancellation yet: keep the failure
    // visible until the evidence is complete, as the production fixture was.
    expect((await getTelephonyHealth(h.deps)).checks.find(check => check.key === "ledger")?.status).toBe("fail");
    for (const leg of h.legs(call.sessionId).filter(leg => !leg.ended_at)) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
    const providerCommands = h.telnyx.calls.length;
    const send = vi.fn(async () => ({ status: "sent" }));
    const report = await getTelephonyHealth(h.deps);
    expect(report.checks.find(check => check.key === "ledger")).toMatchObject({ status: "ok", detail: { resolvedCallEndFailures: 1 } });
    await runTelephonyAlerts({ ...h.deps, recipient: "alerts@example.test", report, send });
    expect(send).not.toHaveBeenCalled();
    expect(h.telnyx.calls).toHaveLength(providerCommands);
  });

  it.each([7, 45, 120])("does not warn or interfere with a connected call after %i quiet minutes", async (minutes) => {
    const { h, call } = await connectedCall();
    const providerCommands = h.telnyx.calls.length;
    h.advance(minutes * 60_000);
    const send = vi.fn(async () => ({ status: "sent" }));
    const report = await getTelephonyHealth(h.deps);
    expect(report.checks.find((check) => check.key === "webhooks")?.status).toBe("ok");
    expect(report.checks.find((check) => check.key === "sessions")?.status).toBe("ok");
    await runTelephonyAlerts({ ...h.deps, recipient: "alerts@example.test", report, send });
    expect(send).not.toHaveBeenCalled();
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.session(call.sessionId).ended_at).toBeNull();
    expect(h.telnyx.calls).toHaveLength(providerCommands);
  });

  it("identifies a separate stalled call while the original conversation remains healthy", async () => {
    const { h, call } = await connectedCall();
    // Keep the new call at reception: no operator or provider work is needed.
    const stalled = await h.inbound({ answer: false });
    h.advance(20 * 60_000);
    // A recently delivered event for the healthy call must not hide the other one.
    h.db.insert("motorist_telnyx_webhook_events", {
      event_id: "unrelated-fresh", organization_id: h.deps.organizationId,
      event_type: "call.recording.saved", status: "processed", received_at: h.now().toISOString(),
    });
    const report = await getTelephonyHealth(h.deps);
    const stuck = report.checks.find((check) => check.key === "sessions");
    expect(stuck?.detail.stuckIds).toEqual([stalled.sessionId]);
    const messages: string[] = [];
    await runTelephonyAlerts({ ...h.deps, recipient: "alerts@example.test", report,
      send: async (message) => { messages.push(message.text); return { status: "sent" }; },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(stalled.sessionId);
    expect(messages[0]).not.toContain(call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
  });
});
