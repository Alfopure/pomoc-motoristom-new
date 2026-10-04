import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, type TelephonyHarness } from "@/test/telephony-harness";

import { alertsFromReport, runTelephonyAlerts, type TelephonyAlertDeps } from "./alerts";
import type { TelephonyHealthReport } from "./health";
import { usageDay } from "./usage";

type SentMessage = Parameters<NonNullable<TelephonyAlertDeps["send"]>>[0];

/** Typed so the assertions can read the message instead of casting it. */
function mailbox() {
  const sent: SentMessage[] = [];
  const send = vi.fn(async (message: SentMessage) => {
    sent.push(message);
    return {};
  });
  return { sent, send };
}

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
    const { sent, send } = mailbox();
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "fail", detail: { stuck: 2 } }]) }));

    expect(result).toMatchObject({ status: "ok", detail: { sent: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "alerts@example.test" });
    expect(sent[0].subject).toContain("Telefónia potrebuje kontrolu");
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(1);
    expect(h.rows("motorist_telephony_alerts")[0]).toMatchObject({ alert_key: `${usageDay(h.now())}:sessions:fail`, status: "fail", sends: 1 });
  });

  it("does not mail the same problem twice in one day", async () => {
    const h = createTelephonyHarness();
    const { send } = mailbox();
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
    const { send } = mailbox();
    await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "usage", status: "warn", detail: { legs: 90 } }], "warn") }));
    await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "usage", status: "fail", detail: { legs: 120 } }]) }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(h.rows("motorist_telephony_alerts").map((row) => row.status).sort()).toEqual(["fail", "warn"]);
  });

  it("stays quiet when nothing is wrong", async () => {
    const h = createTelephonyHarness();
    const { send } = mailbox();
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "ok", detail: {} }], "ok") }));

    expect(result).toMatchObject({ status: "ok", detail: { alerts: 0, sent: 0 } });
    expect(send).not.toHaveBeenCalled();
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("records nothing when there is no recipient, so the first configured address still hears about it", async () => {
    const h = createTelephonyHarness();
    const { send } = mailbox();
    const result = await runTelephonyAlerts(alertDeps(h, { send, recipient: null, report: report([{ key: "sessions", status: "fail", detail: {} }]) }));

    expect(result).toMatchObject({ status: "skipped", detail: { reason: "no_recipient" } });
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("reports a failed send and leaves the alert unsent, so the next tick retries", async () => {
    const h = createTelephonyHarness();
    const send = vi.fn(async (): Promise<unknown> => {
      throw new Error("resend is down");
    });
    const result = await runTelephonyAlerts(alertDeps(h, { send, report: report([{ key: "sessions", status: "fail", detail: {} }]) }));

    expect(result).toMatchObject({ status: "failed", error: "resend is down" });
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
  });

  it("runs off the real health report when none is injected", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "received", updated_at: new Date(h.now().getTime() - 20 * 60_000).toISOString() }, (row) => row.id === sessionId);
    h.advance(20 * 60_000);
    const { send } = mailbox();

    const result = await runTelephonyAlerts(alertDeps(h, { send }));
    expect(result).toMatchObject({ status: "ok", detail: { health: "fail" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0][0] as { text: string }).text)).toContain("Hovor čaká na ďalší krok");
  });

  it.each(["failed", "disabled"])("keeps structured %s transport results retryable", async (status) => {
    const h = createTelephonyHarness();
    const send = vi.fn().mockResolvedValueOnce({ status, error: "mail rejected" }).mockResolvedValue({ status: "sent" });
    const deps = alertDeps(h, { send, report: report([{ key: "usage", status: "fail", detail: {} }]) });
    expect(await runTelephonyAlerts(deps)).toMatchObject({ status: "failed", detail: { sent: 0, deliveryStatus: status } });
    expect(h.rows("motorist_telephony_alerts")).toHaveLength(0);
    expect(await runTelephonyAlerts(deps)).toMatchObject({ status: "ok", detail: { sent: 1 } });
    expect(send.mock.calls[0][0].idempotencyKey).toBe(send.mock.calls[1][0].idempotencyKey);
  });

  it("reports a second affected call the same day without resending the first", async () => {
    const h = createTelephonyHarness();
    const { send, sent } = mailbox();
    const makeReport = (sessionIds: string[]) => report([{ key: "provider", status: "warn", detail: {
      entries: sessionIds.map((sessionId) => ({ sessionId, verdict: "unavailable", checkedAt: h.now().toISOString() })),
    } }], "warn");
    await runTelephonyAlerts(alertDeps(h, { send, report: makeReport(["call-1"]) }));
    h.advance(300_000);
    expect(await runTelephonyAlerts(alertDeps(h, { send, report: makeReport(["call-1"]) }))).toMatchObject({ detail: { sent: 0 } });
    expect(await runTelephonyAlerts(alertDeps(h, { send, report: makeReport(["call-1", "call-2"]) }))).toMatchObject({ detail: { sent: 1 } });
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("call-2");
    expect(sent[1].text).not.toContain("call-1");
  });

  it("scopes ledger events and new incident openings independently", () => {
    const events = alertsFromReport(report([{ key: "ledger", status: "fail", detail: { failedIds: ["e1", "e2"] } }]), "today");
    expect(events).toHaveLength(2);
    expect(events[0].key).not.toBe(events[1].key);
    const jobs = (openedAt: string) => alertsFromReport(report([{ key: "incidents", status: "fail", detail: { jobs: [{ job: "reconcile", openedAt }] } }]), "today");
    expect(jobs("first")[0].key).not.toBe(jobs("second")[0].key);
  });

  it("does not turn repaired connection history into a new failed-call alert", () => {
    const alerts = alertsFromReport(report([{ key: "connections", status: "fail", detail: { entries: [
      { sessionId: "pending", outcome: "pending" }, { sessionId: "repaired", outcome: "confirmed_after_failure" },
    ] } }]), "today");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.sessionIds).toEqual(["pending"]);
  });

  it("respects the connection grace period and includes uncertain ended outcomes", () => {
    const alerts = alertsFromReport(report([{ key: "connections", status: "warn", detail: { entries: [
      { sessionId: "old", outcome: "pending", failedAt: "2026-09-03T07:59:00Z" },
      { sessionId: "fresh", outcome: "pending", failedAt: "2026-09-03T07:59:59Z" },
      { sessionId: "ended", outcome: "ended_without_confirmation" },
    ] } }]), "today");
    expect(alerts.flatMap((alert) => alert.detail.sessionIds)).toEqual(["old", "ended"]);
  });

  it("only scopes affected provider calls and sends warning read errors", () => {
    const alerts = alertsFromReport(report([
      { key: "provider", status: "warn", detail: { sessionIds: ["alive", "unknown"], entries: [
        { sessionId: "alive", verdict: "alive" }, { sessionId: "unknown", verdict: "unknown" },
      ] } },
      { key: "devices", status: "warn", detail: { error: "database unavailable" } },
      { key: "ledger", status: "warn", detail: { stalled: 1 } },
    ]), "today");
    expect(alerts).toHaveLength(2);
    expect(alerts[0].detail.sessionIds).toEqual(["unknown"]);
    expect(alerts[1].check).toBe("devices");
  });

  it("uses an order-independent bounded idempotency key and retries after ledger failure", async () => {
    const h = createTelephonyHarness();
    const { send, sent } = mailbox();
    const checks: TelephonyHealthReport["checks"] = [
      { key: "sessions", status: "fail", detail: { stuckIds: Array.from({ length: 10 }, (_, n) => `call-${n}`) } },
      { key: "usage", status: "fail", detail: {} },
    ];
    h.db.failNext("motorist_telephony_alerts", "insert", "ledger unavailable");
    expect(await runTelephonyAlerts(alertDeps(h, { send, report: report(checks) }))).toMatchObject({ status: "failed" });
    await runTelephonyAlerts(alertDeps(h, { send, report: report([...checks].reverse()) }));
    expect(sent[0].idempotencyKey.length).toBeLessThan(200);
    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey);
  });

  it("separates TEST and production mail to the same recipient with identical copied incident IDs", async () => {
    const production = createTelephonyHarness();
    const test = createTelephonyHarness();
    const { send, sent } = mailbox();
    const failing = report([{ key: "usage", status: "warn", detail: { legs: 90, dailyLegSoftCap: 100 } }], "warn");
    await runTelephonyAlerts(alertDeps(production, { send, report: failing, environment: "production" }));
    // The dedicated TEST project uses Vercel's Production target. Its explicit
    // application environment must control both the label and provider key.
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      await runTelephonyAlerts(alertDeps(test, { send, report: failing }));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe(sent[1].to);
    expect(production.rows("motorist_telephony_alerts")[0].alert_key).toBe(test.rows("motorist_telephony_alerts")[0].alert_key);
    expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
    expect(sent[0].idempotencyKey).toContain("telephony-alert-production-");
    expect(sent[1].idempotencyKey).toContain("telephony-alert-test-");
    expect(sent[0].subject).toContain("[Dispečing · PRODUKCIA]");
    expect(sent[1].subject).toContain("[Dispečing · TEST]");
    expect(sent[1].html).toContain("DISPEČING · TEST");
    expect(sent[1].text).toContain('"environment": "test"');
  });
});
