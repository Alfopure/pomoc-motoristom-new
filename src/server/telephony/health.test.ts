import { describe, expect, it } from "vitest";

import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { getTelephonyHealth, LEDGER_FAILURE_WINDOW_MS, WEBHOOK_SILENCE_WARN_MS } from "./health";
import { TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { usageDay } from "./usage";

function healthDeps(h: TelephonyHarness) {
  return { admin: h.deps.admin, organizationId: ORG, config: h.deps.config, now: h.now };
}

function check(report: Awaited<ReturnType<typeof getTelephonyHealth>>, key: string) {
  const found = report.checks.find((entry) => entry.key === key);
  if (!found) throw new Error(`missing check ${key}`);
  return found;
}

describe("telephony health", () => {
  it("reports a quiet but configured exchange as ok", async () => {
    const h = createTelephonyHarness();
    const report = await getTelephonyHealth(healthDeps(h));

    expect(report.status).toBe("ok");
    expect(check(report, "configuration").detail).toMatchObject({ configured: true, liveCallsEnabled: true });
    // No calls, no webhooks: silence without an active session is not a fault.
    expect(check(report, "webhooks").status).toBe("ok");
    expect(check(report, "sessions").detail).toMatchObject({ active: 0, stuck: 0 });
  });

  it("skips the provider checks when telephony is not configured", async () => {
    const h = createTelephonyHarness();
    const report = await getTelephonyHealth({ ...healthDeps(h), config: { configured: false } });

    // `skipped`, never `ok`: a half-provisioned environment must not look healthy.
    expect(report.status).toBe("skipped");
    expect(check(report, "configuration").status).toBe("skipped");
    expect(check(report, "webhooks").status).toBe("skipped");
  });

  it("fails on a session nobody has touched for longer than the stuck threshold", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", updated_at: new Date(h.now().getTime() - 20 * 60_000).toISOString() }, (row) => row.id === sessionId);

    const report = await getTelephonyHealth(healthDeps(h));
    expect(report.status).toBe("fail");
    expect(check(report, "sessions").detail).toMatchObject({ stuck: 1, stuckIds: [sessionId] });
  });

  it("warns when a live call is running but no webhook has arrived for minutes", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_telnyx_webhook_events", { received_at: new Date(h.now().getTime() - WEBHOOK_SILENCE_WARN_MS - 60_000).toISOString() }, () => true);

    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "webhooks").status).toBe("warn");
    expect(check(report, "webhooks").detail.silenceMs).toBeGreaterThan(WEBHOOK_SILENCE_WARN_MS);
    expect(report.status).toBe("warn");
  });

  it("separates failed ledger rows from claims the replay job will pick up", async () => {
    const h = createTelephonyHarness();
    const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [
      { organization_id: ORG, event_id: "stalled", event_type: "call.answered", status: "queued", attempts: 1, claimed_at: at(120_000), received_at: at(120_000) },
    ]);
    const stalledOnly = await getTelephonyHealth(healthDeps(h));
    expect(check(stalledOnly, "ledger")).toMatchObject({ status: "warn", detail: { stalled: 1, failed24h: 0 } });

    h.db.seed("motorist_telnyx_webhook_events", [
      { organization_id: ORG, event_id: "burned", event_type: "call.answered", status: "failed", attempts: 5, received_at: at(60_000) },
      // Older than the window: the prune job owns it, the health report does not.
      { organization_id: ORG, event_id: "ancient", event_type: "call.answered", status: "failed", attempts: 5, received_at: at(LEDGER_FAILURE_WINDOW_MS + 60_000) },
    ]);
    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "ledger")).toMatchObject({ status: "fail", detail: { failed24h: 1, failedIds: ["burned"] } });
    expect(report.status).toBe("fail");
  });

  it("surfaces an open telephony incident", async () => {
    const h = createTelephonyHarness();
    h.db.seed("motorist_job_incidents", [
      { incident_id: "00000000-0000-4000-8000-000000009001", job_name: TELEPHONY_INCIDENT_JOBS.webhook, status: "open", consecutive_failures: 3, opened_at: h.now().toISOString(), last_error_safe: "boom" },
    ]);

    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "incidents")).toMatchObject({ status: "fail", detail: { open: 1 } });
  });

  it("warns before the daily leg cap and fails once it is reached", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_settings", { daily_leg_soft_cap: 100 }, (row) => row.organization_id === ORG);
    h.db.seed("motorist_telephony_daily_usage", [{ organization_id: ORG, day: usageDay(h.now()), legs: 85, minutes: 40, sms_count: 2 }]);

    const warned = await getTelephonyHealth(healthDeps(h));
    expect(check(warned, "usage")).toMatchObject({ status: "warn", detail: { legs: 85, dailyLegSoftCap: 100 } });

    h.db.update("motorist_telephony_daily_usage", { legs: 100 }, (row) => row.organization_id === ORG);
    const failed = await getTelephonyHealth(healthDeps(h));
    expect(check(failed, "usage").status).toBe("fail");
  });

  it("counts only phones that would actually ring", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_operator_devices", { device_seen_at: new Date(h.now().getTime() - 10 * 60_000).toISOString() }, (row) => row.profile_id === PROFILES.o2);

    const report = await getTelephonyHealth(healthDeps(h));
    const devices = check(report, "devices").detail as { total: number; live: number };
    expect(devices.live).toBeLessThan(devices.total);
    expect(check(report, "devices").status).toBe("ok");
  });
});
