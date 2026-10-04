import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { getTelephonyHealth } from "./health";
import { runTelephonyAlerts } from "./alerts";

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
