import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";
import { ALERT_JOB, runAlertJob } from "./cron-jobs";
import { getTelephonyHealth, LEDGER_RETRY_GRACE_MS } from "./health";
import * as health from "./health";

afterEach(() => vi.restoreAllMocks());

function seed(h: ReturnType<typeof createTelephonyHarness>, age: number, patch: Record<string, unknown> = {}) {
  h.db.seed("motorist_telnyx_webhook_events", [{
    event_id: "11111111-1111-4111-8111-111111111111", organization_id: ORG,
    event_type: "conference.ended", status: "failed", contract_version: 2, attempts: 1,
    effect_failure_count: 0, received_at: new Date(h.now().getTime() - age).toISOString(),
    retry_state: "deferred", terminal_reason: null, claimed_at: null,
    next_attempt_at: new Date(h.now().getTime() + 1_000).toISOString(),
    error: "SessionLeaseBusyError: synthetic contention", ...patch,
  }]);
}

describe("webhook alarm recovery uses the existing health verdict", () => {
  it.each([
    ["fresh durable retry", LEDGER_RETRY_GRACE_MS - 1, {}, false],
    ["exact grace boundary", LEDGER_RETRY_GRACE_MS, {}, true],
    ["older retry", LEDGER_RETRY_GRACE_MS + 60_000, {}, true],
    ["processed retry", LEDGER_RETRY_GRACE_MS + 60_000, { status: "processed" }, false],
    ["terminal fact", 1_000, { retry_state: "dead_letter", terminal_reason: "retry_expired" }, true],
    ["missing durable schedule", 1_000, { next_attempt_at: null }, true],
  ] as const)("%s", async (_label, age, patch, alarm) => {
    const h = createTelephonyHarness();
    seed(h, age, patch);
    const report = await getTelephonyHealth(h.deps);
    const observe = vi.fn();
    const result = await runAlertJob({ ...h.deps, onJobError: observe, alerts: { report, recipient: null } });
    // Sentry observation remains independent of the optional direct-mail recipient.
    expect(result.status).toBe(alarm ? "skipped" : "ok");
    expect(observe).toHaveBeenCalledTimes(alarm ? 1 : 0);
    if (alarm) expect(observe).toHaveBeenCalledWith(expect.objectContaining({ code: "webhook_recovery_failed" }), ALERT_JOB);
  });

  it("contains an observer exception and preserves the mail job result", async () => {
    const h = createTelephonyHarness();
    seed(h, LEDGER_RETRY_GRACE_MS);
    const report = await getTelephonyHealth(h.deps);
    const result = await runAlertJob({ ...h.deps, alerts: { report, recipient: null }, onJobError: () => { throw new Error("observer unavailable"); } });
    expect(result.status).toBe("skipped");
  });

  it("loads health once even with an explicit undefined report override", async () => {
    const h = createTelephonyHarness();
    const report = { status: "ok" as const, checkedAt: h.now().toISOString(), organizationId: ORG, checks: [] };
    const read = vi.spyOn(health, "getTelephonyHealth").mockResolvedValue(report);
    const result = await runAlertJob({ ...h.deps, alerts: { report: undefined, recipient: "qa@example.test", send: vi.fn() } });
    expect(result.status).toBe("ok");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
