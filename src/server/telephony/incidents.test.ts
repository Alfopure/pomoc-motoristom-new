import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import { describeIncidentError, recordTelephonyIncident, recoverTelephonyIncident, TELEPHONY_INCIDENT_JOBS } from "./incidents";

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

  it("describes errors safely with context and a length cap", () => {
    expect(describeIncidentError(new TypeError("bad"), { a: 1 })).toBe('TypeError: bad {"a":1}');
    expect(describeIncidentError("x".repeat(3000)).length).toBe(2000);
  });
});
