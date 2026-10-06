import { describe, expect, it } from "vitest";
import type { TelephonyCronSummary } from "./cron-jobs";
import { completeCronSummary, cronRuntimeObservation } from "./cron-observation";

const summary = (health?: string): TelephonyCronSummary => ({ status: "ok", checkedAt: "2026-10-06T08:00:01.000Z", organizationId: "org", configured: true, ms: 1,
  jobs: health ? [{ job: "telephony.alerts", status: "ok", detail: { health } }] : [] });
const start = Date.parse("2026-10-06T08:00:00.000Z");

describe("completed cron observation", () => {
  it("uses completion time and includes the tail in total duration", () => {
    const result = completeCronSummary(summary("ok"), [{ job: "diagnostics.maintenance", status: "ok", detail: {} }], start, start + 1250);
    expect(result).toMatchObject({ status: "ok", executionStatus: "ok", telephonyHealth: "ok", diagnosticsStatus: "ok", startedAt: "2026-10-06T08:00:00.000Z", checkedAt: "2026-10-06T08:00:01.250Z", ms: 1250 });
  });

  it("does not treat an unobserved configured exchange as healthy", () => {
    expect(completeCronSummary(summary(), [], start, start)).toMatchObject({ status: "degraded", executionStatus: "ok", telephonyHealth: "unknown" });
    expect(completeCronSummary(summary("skipped"), [], start, start)).toMatchObject({ status: "ok", telephonyHealth: "skipped" });
  });

  it("shows blocked collection even when maintenance itself completed", () => {
    expect(completeCronSummary(summary("ok"), [{ job: "diagnostics.maintenance", status: "ok", detail: { blocked: true } }], start, start))
      .toMatchObject({ status: "degraded", executionStatus: "ok", diagnosticsStatus: "blocked", failedJobs: [] });
  });

  it("keeps disabled jobs neutral and preserves an earlier execution failure", () => {
    const result = completeCronSummary({ ...summary("ok"), status: "degraded" }, [{ job: "diagnostics.maintenance", status: "disabled", detail: {} }], start, start);
    expect(result).toMatchObject({ status: "degraded", executionStatus: "degraded", diagnosticsStatus: "disabled" });
  });

  it("logs only allowlisted observation data, not job errors, IDs or provider details", () => {
    const source = summary("fail");
    source.jobs[0].detail = { ...source.jobs[0].detail, alerts: 13, sent: "unsafe text", suppressed: -1, sessionId: "private-call", providerPayload: "private-provider" };
    source.jobs[0].error = "private-error";
    const result = cronRuntimeObservation(completeCronSummary(source, [], start, start));
    expect(result.alerts).toEqual({ detected: 13, sent: null, suppressed: null });
    expect(JSON.stringify(result)).not.toMatch(/private|unsafe|organizationId/);
  });
});
