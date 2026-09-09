import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";
import { classifyConnectionFailure, getRecentConnectionOutcomes } from "./connection-outcomes";

const failure = { eventId: "answer-event", sessionId: "session", failedAt: "2026-09-09T14:06:14Z", eventAt: "2026-09-09T14:06:03Z", commands: [{ id: "bridge-command", kind: "bridge" }] };

describe("connection outcome after replay", () => {
  it("retains ended without confirmation after the ledger was processed", async () => {
    const h = createTelephonyHarness();
    h.db.seed("motorist_call_sessions", [{ id: "session", organization_id: ORG, state: "ended", ended_at: "2026-09-09T14:06:47Z", metadata: {} }]);
    h.db.seed("motorist_call_events", [{ id: "answer-event", organization_id: ORG, handled_status: "failed", created_at: failure.failedAt,
      provider_timestamp: failure.eventAt, normalized_payload: { session_id: "session", error: "recording continuation superseded; delayed audio action cancelled", commands: [{ kind: "bridge", ok: false }] } }]);
    h.db.seed("motorist_telnyx_webhook_events", [{ organization_id: ORG, event_id: "answer-event", status: "processed", attempts: 2 }]);
    const result = await getRecentConnectionOutcomes({ admin: h.deps.admin, organizationId: ORG, since: "2026-09-09T14:00:00Z" });
    expect(result.entries).toEqual([{ eventId: "answer-event", sessionId: "session", failedAt: failure.failedAt, outcome: "ended_without_confirmation" }]);
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it("records later participant confirmation separately from a processed webhook", () => {
    expect(classifyConnectionFailure({ ...failure, session: { state: "ended", ended_at: "2026-09-09T14:06:47Z", metadata: {
      recording: { connection: { commandId: "bridge-command", confirmedAt: "2026-09-09T14:06:20Z" } } } } }).outcome).toBe("confirmed_after_failure");
  });

  it("does not infer cancellation from a later hangup, park or objection", () => {
    expect(classifyConnectionFailure({ ...failure, session: { state: "waiting", ended_at: null, metadata: {} } }).outcome).toBe("unknown");
    expect(classifyConnectionFailure({ ...failure, session: { state: "ended", ended_at: "2026-09-09T14:06:10Z", metadata: {} } }).outcome).toBe("ended_without_confirmation");
    expect(classifyConnectionFailure({ ...failure, session: { state: "talking", ended_at: null, metadata: {
      recording: { suppressionReason: "objection", suppressedAt: "2026-09-09T14:06:10Z" } } } }).outcome).toBe("unknown");
  });

  it("does not credit an unrelated new bridge or historical commands without identity", () => {
    const session = { state: "talking", ended_at: null, metadata: { recording: { connection: { commandId: "new-pickup", confirmedAt: "2026-09-09T14:06:20Z" } } } };
    expect(classifyConnectionFailure({ ...failure, session }).outcome).toBe("unknown");
    expect(classifyConnectionFailure({ ...failure, commands: [{ id: null, kind: "bridge" }], session }).outcome).toBe("unknown");
  });

  it("only marks an identifiable still queued audio command pending", () => {
    const session = { state: "talking", ended_at: null, metadata: { recording: { pendingAudio: { commands: [{ commandId: "bridge-command" }] } } } };
    expect(classifyConnectionFailure({ ...failure, session }).outcome).toBe("pending");
  });

  it("correlates a successful unhold retry without claiming confirmed physical audio", async () => {
    const h = createTelephonyHarness();
    h.db.seed("motorist_call_sessions", [{ id: "session", organization_id: ORG, state: "talking", ended_at: null, metadata: {} }]);
    h.db.seed("motorist_call_events", [
      { id: "failure", organization_id: ORG, handled_status: "failed", created_at: failure.failedAt, provider_timestamp: failure.eventAt,
        normalized_payload: { session_id: "session", commands: [{ kind: "conference_unhold", command_id: "unhold-command", ok: false }] } },
      { id: "recovery", organization_id: ORG, handled_status: "processed", created_at: "2026-09-09T14:06:20Z",
        normalized_payload: { session_id: "session", commands: [{ kind: "conference_unhold", command_id: "unhold-command", ok: true, skipped: false }] } },
    ]);
    const result = await getRecentConnectionOutcomes({ admin: h.deps.admin, organizationId: ORG, since: "2026-09-09T14:00:00Z" });
    expect(result.entries[0].outcome).toBe("command_recovered");
    h.db.update("motorist_call_events", { normalized_payload: { session_id: "session", commands: [{ kind: "conference_unhold", command_id: "unhold-command", ok: true, skipped: true }] } }, (row) => row.id === "recovery");
    const skipped = await getRecentConnectionOutcomes({ admin: h.deps.admin, organizationId: ORG, since: "2026-09-09T14:00:00Z" });
    expect(skipped.entries[0].outcome).toBe("unknown");
  });
});
