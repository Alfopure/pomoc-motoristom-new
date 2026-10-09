import { describe, expect, it, vi } from "vitest";
import { createTelephonyHarness } from "@/test/telephony-harness";
import { runPendingEffectRecovery } from "./cron-jobs";
import type { InboundHangupRecovery } from "./inbound-hangup-recovery";
import { TELEPHONY_INCIDENT_JOBS } from "./incidents";

describe("inbound hangup recovery monitoring", () => {
  it.each(["backoff", "provider_unknown", "retry_pending", "retry_exhausted", "rejected", "unavailable"] as const)(
    "reports %s as unresolved even when ordinary effects are scheduled for later", async status => {
      const h = createTelephonyHarness();
      const [session] = h.db.seed("motorist_call_sessions", [{ organization_id: h.deps.organizationId,
        state: "ended", pending_effects: { version: 1, entries: [] }, effects_next_attempt_at: h.now().toISOString() }]);
      const recovery: InboundHangupRecovery = { status, attemptCount: 2, pendingAgeMs: 90_000 };
      const result = await runPendingEffectRecovery({ ...h.deps, runSession: vi.fn(async () => {
        h.db.update("motorist_call_sessions", { effects_next_attempt_at: new Date(h.now().getTime() + 30_000).toISOString() }, row => row.id === session.id);
        return { outcome: "applied", inboundHangupRecovery: recovery };
      }) });
      expect(result).toMatchObject({ status: "failed", detail: {
        inboundHangups: [{ sessionId: session.id, ...recovery }],
        errors: [{ sessionId: session.id, error: `Inbound hangup remains unresolved: ${status}` }],
      } });
      const incidents = h.db.rows("motorist_job_incidents");
      if (status === "retry_exhausted" || status === "rejected") {
        expect(incidents).toEqual([expect.objectContaining({ job_name: TELEPHONY_INCIDENT_JOBS.commands, status: "open" })]);
      } else expect(incidents).toHaveLength(0);
    });

  it("allows recovery only after terminal proof and the remaining durable effects have completed", async () => {
    const h = createTelephonyHarness();
    const [session] = h.db.seed("motorist_call_sessions", [{ organization_id: h.deps.organizationId,
      state: "ended", pending_effects: { version: 1, entries: [] }, effects_next_attempt_at: h.now().toISOString() }]);
    const result = await runPendingEffectRecovery({ ...h.deps, runSession: vi.fn(async () => {
      h.db.update("motorist_call_sessions", { pending_effects: null, effects_next_attempt_at: null }, row => row.id === session.id);
      return { outcome: "applied", inboundHangupRecovery: { status: "terminal_confirmed", attemptCount: 1, pendingAgeMs: 90_000 } };
    }) });
    expect(result).toMatchObject({ status: "ok", detail: { errors: [], inboundHangups: [
      { sessionId: session.id, status: "terminal_confirmed", attemptCount: 1, pendingAgeMs: 90_000 },
    ] } });
  });
});
