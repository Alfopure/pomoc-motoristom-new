import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, type TelephonyHarness } from "@/test/telephony-harness";

import { alertsFromReport, runTelephonyAlerts } from "./alerts";
import type { TelephonyHealthReport } from "./health";
import { usageDay } from "./usage";

function report(checks: TelephonyHealthReport["checks"], status: TelephonyHealthReport["status"] = "fail"): TelephonyHealthReport {
  return { status, checkedAt: "2026-09-03T08:00:00.000Z", organizationId: ORG, checks };
}

function alertDeps(h: TelephonyHarness, overrides: Partial<Parameters<typeof runTelephonyAlerts>[0]> = {}) {
  return { admin: h.deps.admin, organizationId: ORG, config: h.deps.config, now: h.now, recipient: "alerts@example.test", ...overrides };
}

describe("telephony alerts", () => {
  it("alerts on every failure but only on the warnings worth waking up for", () => {
    const alerts = alertsFromReport(
      report([
        { key: "sessions", status: "fail", detail: { stuck: 1 } },
        { key: "usage", status: "warn", detail: { legs: 90 } },
        { key: "webhooks", status: "warn", detail: { silenceMs: 400_000 } },
        // A warning the health route shows but nobody needs at night.
        { key: "ledger", status: "warn", detail: { stalled: 1 } },
        { key: "devices", status: "ok", detail: {} },
      ]),
      "2026-09-03",
    );

    expect(alerts.map((alert) => alert.key)).toEqual(["2026-09-03:sessions:fail", "2026-09-03:usage:warn", "2026-09-03:webhooks:warn"]);
  });

  it("sends one mail and records the keys it covered", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => ({}));
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "fail", detail: { stuck: 2 } }]) }));

    expect(result).toMatchObject({ status: "ok", detail: { sent: 1 } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "alerts@example.test" });
    expect(String((send.mock.calls[0][0] as { subject: string }).subject)).toContain("chybu");
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(1);
    expect(h.rows("motorist_telephony_alerts")[0]).toMatchObject({ alert_key: `${usageDay(h.now())}:sessions:fail`, status: "fail", sends: 1 });
  });

  it("does not mail the same problem twice in one day", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => ({}));
    const failing = report([{ key: "sessions", status: "fail", detail: { stuck: 2 } }]);
    await runTelephonyAlerts(alertDeps(h, { send, report: failing }));

    const second = await runTelephonyAlerts(alertDeps(h, { send, report: failing }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: "ok", detail: { sent: 0, suppressed: 1 } });
    // The row keeps counting so the runbook can tell one blip from all night.
    expect(h.rows("motorist_telephony_alerts")[0].last_seen_at).toBe(h.now().toISOString());
  });

  it("mails again when the same check gets worse", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => ({}));
    await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "usage", status: "warn", detail: { legs: 90 } }], "warn") }));
    await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "usage", status: "fail", detail: { legs: 120 } }]) }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(h.rows("motorist_telephony_alerts").map((row) => row.status).sort()).toEqual(["fail", "warn"]);
  });

  it("stays quiet when nothing is wrong", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => ({}));
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "ok", detail: {} }], "ok") }));

    expect(result).toMatchObject({ status: "ok", detail: { alerts: 0, sent: 0 } });
    expect(send).not.toHaveBeenCalled();
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("records nothing when there is no recipient, so the first configured address still hears about it", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => ({}));
    const result = await runTelephonyAlerts(alertDeps(h, { send, recipient: null, report: report([{ key: "sessions", status: "fail", detail: {} }]) }));

    expect(result).toMatchObject({ status: "skipped", detail: { reason: "no_recipient" } });
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("reports a failed send and leaves the alert unsent, so the next tick retries", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async () => {
      throw new Error("resend is down");
    });
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "fail", detail: {} }]) }));

    expect(result).toMatchObject({ status: "failed", error: "resend is down" });
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("runs off the real health report when none is injected", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", updated_at: new Date(h.now().getTime() - 20 * 60_000).toISOString() }, (row) => row.id === sessionId);
    const send = vi.fn(async () => ({}));

    const result = await runTelephonyAlerts(alertDeps(h, { send }));
    expect(result).toMatchObject({ status: "ok", detail: { health: "fail", sent: 1 } });
    expect(String((send.mock.calls[0][0] as { text: string }).text)).toContain("Zaseknuté hovory");
  });
});
