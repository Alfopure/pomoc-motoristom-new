import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { loadTelephonyAlertEvidence } from "./alert-evidence";
import { runTelephonyAlerts, type TelephonyAlert } from "./alerts";

const ORG = "org";
const NOW = "2026-10-04T11:00:00Z";
const scoped = (id: string): TelephonyAlert => ({ key: "today:sessions:fail", check: "sessions", status: "fail", detail: { sessionIds: [id] } });
function fixture() {
  const h = createFakeSupabase();
  h.db.seed("motorist_call_sessions", [
    { id: "call-1", organization_id: ORG, state: "talking", direction: "inbound", started_at: NOW, answered_at: NOW, caller_number: "+421905123456", called_number: "+421232408718", telnyx_session_id: "provider-session", metadata: { auth: "must-not-leak" } },
    { id: "other-call", organization_id: ORG, state: "talking", metadata: { recording: { connection: { confirmedAt: NOW } } } },
    { id: "foreign-call", organization_id: "another-org", state: "talking", metadata: { recording: { connection: { confirmedAt: NOW } } } },
  ]);
  return h;
}

describe("bounded relevant telephony alert evidence", () => {
  it("reads only the specified organization and call, never an unrelated latest call", async () => {
    const h = fixture();
    h.db.seed("motorist_call_legs", [
      { id: "customer", organization_id: ORG, session_id: "call-1", role: "customer", state: "bridged", bridged_at: NOW },
      { id: "operator", organization_id: ORG, session_id: "call-1", role: "operator", state: "bridged", bridged_at: NOW },
      { id: "foreign", organization_id: "another-org", session_id: "call-1", role: "external", bridged_at: NOW },
    ]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1"), scoped("foreign-call")] });
    expect(evidence.calls).toHaveLength(1);
    expect(evidence.calls[0]).toMatchObject({ sessionId: "call-1", caller: "•••3456", called: "•••8718", confirmedAt: NOW, confirmationSource: "bridge_events" });
    expect(evidence.calls[0].legs).toHaveLength(2);
    expect(evidence.missingSessionIds).toEqual(["foreign-call"]);
    expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
    expect(JSON.stringify(evidence)).not.toContain("other-call");
    expect(h.db.log.every((entry) => entry.operation === "select")).toBe(true);
  });

  it("does not treat answered times as bridge evidence", async () => {
    const h = fixture();
    h.db.seed("motorist_call_legs", [{ id: "customer", organization_id: ORG, session_id: "call-1", role: "customer", answered_at: NOW }]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1")] });
    expect(evidence.calls[0].confirmedAt).toBeNull();
  });

  it("projects conference membership and pending follow-up separately without raw recording metadata", async () => {
    const h = fixture();
    h.db.update("motorist_call_sessions", { metadata: { recording: { connection: { confirmedAt: NOW }, pendingAudio: { commands: [{ kind: "bridge", callControlId: "private-id" }] }, secret: "private-secret" } } }, (row) => row.id === "call-1");
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1")] });
    expect(evidence.calls[0]).toMatchObject({ confirmedAt: NOW, confirmationSource: "conference_membership", pendingConnection: true });
    expect(JSON.stringify(evidence)).not.toContain("private-");
  });

  it.each(["leg", "session"])("correlates failed ledger IDs via provider %s identity", async (by) => {
    const h = fixture();
    const control = `v3:${"opaque+/=".repeat(30)}`;
    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "event-1", organization_id: ORG, event_type: "call.hangup", received_at: NOW, call_control_id: by === "leg" ? control : null, call_session_id: by === "session" ? "provider-session" : null, payload: { token: "not-selected" } }]);
    h.db.seed("motorist_call_legs", [{ id: "leg-1", organization_id: ORG, session_id: "call-1", role: "external", telnyx_call_control_id: control }]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [{ key: "ledger", check: "ledger", status: "fail", detail: { failedIds: ["event-1"] } }] });
    expect(evidence.calls.map((call) => call.sessionId)).toEqual(["call-1"]);
    expect(evidence.events[0]).toMatchObject({ eventId: "event-1", type: "call.hangup", sessionIds: ["call-1"] });
    expect(JSON.stringify(evidence)).not.toContain("not-selected");
  });

  it("marks missing ledger or call correlation as incomplete", async () => {
    const h = fixture();
    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "unknown-call", organization_id: ORG, event_type: "call.hangup" }]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [{ key: "ledger", check: "ledger", status: "fail", detail: { failedIds: ["missing-event", "unknown-call"] } }] });
    expect(evidence.errors).toContain("ledger_events_missing");
    expect(evidence.errors).toContain("ledger_session_unknown: unknown-call");
    expect(evidence.calls).toHaveLength(0);
  });

  it("preserves cancellation and classifies the failure without copying error bodies or pending commands", async () => {
    const h = fixture();
    h.db.update("motorist_call_sessions", { state: "ended", ended_at: NOW, answered_at: null,
      pending_effects: { entries: [{ api_key: "pending-secret" }] } }, row => row.id === "call-1");
    h.db.seed("motorist_call_legs", [{ id: "customer", organization_id: ORG, session_id: "call-1", role: "customer",
      state: "ended", ended_at: NOW, hangup_source: "caller", hangup_cause: "normal_clearing" }]);
    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "timeout", organization_id: ORG, event_type: "call.answered",
      call_session_id: "provider-session", error: "AbortError: owned database request exceeded 4000 ms api_key=error-secret" }]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG,
      alerts: [{ key: "ledger", check: "ledger", status: "fail", detail: { failedIds: ["timeout"] } }] });
    expect(evidence.events[0].failureKind).toBe("database_timeout");
    expect(evidence.calls[0]).toMatchObject({ pendingWork: true, legs: [{ hangupSource: "caller", hangupCause: "normal_clearing" }] });
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });

  it("keeps the health failure category if replay clears the raw error before email enrichment", async () => {
    const h = fixture();
    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "timeout", organization_id: ORG, event_type: "call.answered",
      call_session_id: "provider-session", error: null }]);
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG,
      alerts: [{ key: "ledger", check: "ledger", status: "fail", detail: { failedIds: ["timeout"], failures: [{ eventId: "timeout", kind: "database_timeout" }] } }] });
    expect(evidence.events[0].failureKind).toBe("database_timeout");
  });

  it("retains pending cleanup without exposing private details or confusing a completed tombstone with work", async () => {
    const h = fixture();
    h.db.update("motorist_call_sessions", { pending_effects: null, cancellations_next_attempt_at: NOW,
      termination_next_attempt_at: null, presence_cancellations: { operator: { callControlId: "cleanup-secret" } } }, row => row.id === "call-1");
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1")] });
    expect(evidence.calls[0].pendingWork).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("cleanup-secret");
    h.db.update("motorist_call_sessions", { cancellations_next_attempt_at: null }, row => row.id === "call-1");
    const completed = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1")] });
    expect(completed.calls[0].pendingWork).toBe(false);
  });

  it.each(["motorist_call_sessions", "motorist_call_legs"])("still sends the original alert if %s evidence cannot be read", async (table) => {
    const h = fixture();
    h.db.failNext(table, "select", "evidence unavailable");
    const messages: string[] = [];
    const result = await runTelephonyAlerts({ admin: h.admin, organizationId: ORG, config: { configured: true }, recipient: "example@example.test", environment: "test",
      now: () => new Date(NOW), report: { status: "fail", checkedAt: NOW, organizationId: ORG, checks: [{ key: "sessions", status: "fail", detail: { sessionIds: ["call-1"] } }] },
      send: async ({ text }) => { messages.push(text); return { status: "sent" }; },
    });
    expect(result.status).toBe("ok");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Časť údajov chýba");
  });

  it("bounds session and leg enrichment and exposes truncation", async () => {
    const h = fixture();
    h.db.seed("motorist_call_legs", Array.from({ length: 250 }, (_, i) => ({ id: `leg-${i}`, organization_id: ORG, session_id: "call-1", role: "operator" })));
    const evidence = await loadTelephonyAlertEvidence({ admin: h.admin, organizationId: ORG, alerts: [scoped("call-1"), ...Array.from({ length: 25 }, (_, i) => scoped(`call-${i + 2}`))] });
    expect(evidence.requestedSessionIds).toHaveLength(20);
    expect(evidence.calls[0].legs).toHaveLength(200);
    expect(evidence.truncated).toBe(true);
  });
});
