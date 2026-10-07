import { describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import {
  describeIncidentError,
  INCIDENT_RECOVERY_INTERVAL_MS,
  recordTelephonyIncident,
  recoverTelephonyIncident,
  recoverTelephonyIncidentThrottled,
  resetIncidentRecoveryThrottle,
  TELEPHONY_INCIDENT_JOBS,
} from "./incidents";

describe("telephony incidents", () => {
  it("opens one incident per job and increments consecutive failures", async () => {
    const { admin, db } = createFakeSupabase({ now: () => new Date("2026-09-03T08:00:00.000Z") });
    const first = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error: new Error("boom"), context: { eventId: "evt-1" } });
    expect(first).toMatchObject({ recorded: true, consecutiveFailures: 1, error: null });
    const second = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error: "later" });
    expect(second).toMatchObject({ recorded: true, consecutiveFailures: 2, incidentId: first.incidentId });
    const other = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: new Error("cmd") });
    expect(other.incidentId).not.toBe(first.incidentId);
    expect(db.rows("motorist_job_incidents")).toHaveLength(2);
    expect(db.rows("motorist_job_incidents")[0]).toMatchObject({ job_name: "telephony.telnyx.webhook", status: "open", consecutive_failures: 2, last_error_safe: "later" });
  });

  it("recovers the open incident and never throws on database errors", async () => {
    const { admin, db } = createFakeSupabase();
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.actions, error: new Error("x") });
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.actions)).toBe(true);
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.actions)).toBe(false);
    expect(db.rows("motorist_job_incidents")[0].status).toBe("recovered");

    db.failNext("motorist_job_incidents", "select", "db down");
    const result = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.actions, error: new Error("y") });
    expect(result).toMatchObject({ recorded: false, error: "db down" });
  });

  it("closes an incident from a clean run at most once per interval per instance", async () => {
    resetIncidentRecoveryThrottle();
    const { admin, db } = createFakeSupabase();
    const start = new Date("2026-09-03T08:00:00.000Z");
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: new Error("boom"), now: start });

    expect(await recoverTelephonyIncidentThrottled(admin, TELEPHONY_INCIDENT_JOBS.commands, start)).toBe(true);
    expect(db.rows("motorist_job_incidents")[0]).toMatchObject({ status: "recovered", recovered_at: start.toISOString() });

    // An incident opened by another instance (no local `record`, so the memo
    // still holds) is left alone until the interval has passed: the clean paths
    // run on every webhook and must not query each time.
    db.seed("motorist_job_incidents", [
      { job_name: TELEPHONY_INCIDENT_JOBS.commands, status: "open", consecutive_failures: 1, opened_at: start.toISOString(), last_error_safe: "other instance", updated_at: start.toISOString() },
    ]);
    expect(await recoverTelephonyIncidentThrottled(admin, TELEPHONY_INCIDENT_JOBS.commands, new Date(start.getTime() + 1_000))).toBe(false);
    expect(db.rows("motorist_job_incidents").filter((row) => row.status === "open")).toHaveLength(1);

    // After the interval it is closed.
    expect(await recoverTelephonyIncidentThrottled(admin, TELEPHONY_INCIDENT_JOBS.commands, new Date(start.getTime() + INCIDENT_RECOVERY_INTERVAL_MS + 1))).toBe(true);
    expect(db.rows("motorist_job_incidents").filter((row) => row.status === "open")).toHaveLength(0);

    // A new local failure invalidates the memo so the next clean run closes it immediately.
    const failedAt = new Date(start.getTime() + INCIDENT_RECOVERY_INTERVAL_MS + 2_000);
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: new Error("again"), now: failedAt });
    expect(await recoverTelephonyIncidentThrottled(admin, TELEPHONY_INCIDENT_JOBS.commands, new Date(failedAt.getTime() + 1_000))).toBe(true);
    expect(db.rows("motorist_job_incidents").filter((row) => row.status === "open")).toHaveLength(0);
  });

  it("describes errors safely with context and a length cap", () => {
    expect(describeIncidentError(new TypeError("bad"), { a: 1 })).toBe('TypeError: bad {"a":1}');
    expect(describeIncidentError("x".repeat(3000)).length).toBe(2000);
  });

  const pendingHangup = (completed = false) => ({ version: 1, entries: [{
    event: { kind: "app", type: "hangup" },
    commands: [{ kind: "hangup", commandId: "original-hangup" }],
    completedCommands: completed ? ["original-hangup"] : [],
  }] });

  it("does not recover a commands incident while another ended call still owes an explicit hangup", async () => {
    const { admin, db } = createFakeSupabase();
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: "hangup unknown" });
    db.seed("motorist_call_sessions", [{ id: "other-call", state: "ended", ended_at: "2026-10-07T08:00:00Z",
      termination_requested_at: "2026-10-07T07:59:00Z", pending_effects: pendingHangup() }]);
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.commands)).toBe(false);
    expect(db.rows("motorist_job_incidents")[0].status).toBe("open");
    db.update("motorist_call_sessions", { pending_effects: pendingHangup(true) }, row => row.id === "other-call");
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.commands)).toBe(true);
  });

  it.each(["query failure", "malformed contract", "malformed command", "too many pending calls"])("keeps commands incidents open on %s", async scenario => {
    const { admin, db } = createFakeSupabase();
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: "unknown" });
    if (scenario === "query failure") db.failNext("motorist_call_sessions", "select", "unavailable");
    else db.seed("motorist_call_sessions", Array.from({ length: scenario === "too many pending calls" ? 101 : 1 }, (_, index) => ({
      id: `call-${index}`, termination_requested_at: "2026-10-07T07:59:00Z",
      pending_effects: scenario === "malformed contract" ? { version: 999, entries: [] }
        : scenario === "malformed command" ? { version: 1, entries: [{ ...pendingHangup(true).entries[0], commands: [{}] }] } : pendingHangup(true),
    })));
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.commands)).toBe(false);
    expect(db.rows("motorist_job_incidents")[0].status).toBe("open");
  });

  it("does not clear a new concurrent failure even when it has the same timestamp", async () => {
    const { admin, db } = createFakeSupabase();
    const now = new Date("2026-10-07T08:00:00Z");
    await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: "first", now });
    const original = db.takeInjectedError.bind(db);
    let injected = false;
    vi.spyOn(db, "takeInjectedError").mockImplementation((table, operation) => {
      if (!injected && table === "motorist_job_incidents" && operation === "update") {
        injected = true;
        db.update(table, { consecutive_failures: 2, last_error_safe: "new concurrent failure" }, row => row.status === "open");
      }
      return original(table, operation);
    });
    expect(await recoverTelephonyIncident(admin, TELEPHONY_INCIDENT_JOBS.commands, now)).toBe(false);
    expect(db.rows("motorist_job_incidents")[0]).toMatchObject({ status: "open", consecutive_failures: 2 });
  });

  it("opens a new incident when another instance recovers the row just before recording a failure", async () => {
    const { admin, db } = createFakeSupabase();
    const first = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: "first" });
    const original = db.takeInjectedError.bind(db);
    let injected = false;
    vi.spyOn(db, "takeInjectedError").mockImplementation((table, operation) => {
      if (!injected && table === "motorist_job_incidents" && operation === "update") {
        injected = true;
        db.update(table, { status: "recovered" }, row => row.incident_id === first.incidentId);
      }
      return original(table, operation);
    });
    const next = await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: "new failure" });
    expect(next.recorded).toBe(true);
    expect(next.incidentId).not.toBe(first.incidentId);
    expect(db.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([
      expect.objectContaining({ last_error_safe: "new failure", consecutive_failures: 1 }),
    ]);
    expect(db.rows("motorist_job_incidents").find(row => row.incident_id === first.incidentId)?.last_error_safe).toBe("first");
  });
});
