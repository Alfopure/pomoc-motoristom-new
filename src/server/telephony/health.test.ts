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

  it("fails on missing progress in an unfinished incoming call", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "received", metadata: {}, started_at: new Date(h.now().getTime() - 20 * 60_000).toISOString() }, (row) => row.id === sessionId);

    const report = await getTelephonyHealth(healthDeps(h));
    expect(report.status).toBe("fail");
    expect(check(report, "sessions").detail).toMatchObject({ stuck: 1, stuckIds: [sessionId] });
  });

  it("warns about overdue ringing even after an unrelated webhook and maintenance write", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { metadata: { ring: { step_deadline_at: new Date(h.now().getTime() - WEBHOOK_SILENCE_WARN_MS - 60_000).toISOString() } }, updated_at: h.now().toISOString() }, (row) => row.id === sessionId);

    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "webhooks").status).toBe("warn");
    expect(check(report, "webhooks").detail).toMatchObject({ sessionIds: [sessionId], silenceMs: 0,
      entries: [expect.objectContaining({ sessionId, reason: "ringing_overdue" })] });
    expect(report.status).toBe("warn");
  });

  it.each(["talking", "held", "consulting", "conference"])("does not turn a long %s conversation into webhook/stuck failure", async (state) => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId, callControlId } = await h.inbound({ to: "+421232408718" });
    const operatorId = h.openLegFor(sessionId, PROFILES.o1)!.telnyx_call_control_id;
    await h.legEvent(String(operatorId), "call.answered");
    await h.legEvent(String(operatorId), "call.bridged");
    await h.legEvent(callControlId, "call.bridged");
    h.db.update("motorist_call_sessions", { state, metadata: {} }, row => row.id === sessionId);
    h.advance(90 * 60_000);
    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "sessions").status).toBe("ok");
    expect(check(report, "webhooks").status).toBe("ok");
    expect(check(report, "provider")).toMatchObject({ status: "skipped", detail: { reason: "not_checked", unverifiedSessionIds: [sessionId] } });
    expect(report.status).toBe("ok");
  });

  it("requires current bridge evidence even without recording metadata", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    await h.legEvent(String(h.openLegFor(sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.answered");
    h.db.update("motorist_call_sessions", { metadata: {} }, row => row.id === sessionId);
    h.advance(6 * 60_000);
    expect(check(await getTelephonyHealth(healthDeps(h)), "webhooks")).toMatchObject({ status: "warn",
      detail: { entries: [expect.objectContaining({ sessionId, reason: "connection_unconfirmed" })] } });
  });

  it("recognizes a bridged personal mobile as the current operator", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId, callControlId } = await h.inbound({ to: "+421232408718" });
    const operator = h.openLegFor(sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    await h.legEvent(String(operator.telnyx_call_control_id), "call.bridged");
    await h.legEvent(callControlId, "call.bridged");
    h.db.update("motorist_call_legs", { role: "external" }, row => row.id === operator.id);
    h.db.update("motorist_call_sessions", { metadata: {} }, row => row.id === sessionId);
    h.advance(30 * 60_000);
    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "webhooks").status).toBe("ok");
    expect(check(report, "sessions").status).toBe("ok");
  });

  it("uses the exact winning leg instead of a late answered device of the same operator", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId, callControlId } = await h.inbound({ to: "+421232408718" });
    const operator = h.openLegFor(sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    await h.legEvent(String(operator.telnyx_call_control_id), "call.bridged");
    await h.legEvent(callControlId, "call.bridged");
    h.db.update("motorist_call_sessions", { metadata: { answered_leg_call_control_id: operator.telnyx_call_control_id } }, row => row.id === sessionId);
    h.db.seed("motorist_call_legs", [{ ...operator, id: "00000000-late-loser", telnyx_call_control_id: "late-loser", telnyx_call_leg_id: "late-loser-leg", answered_at: h.now().toISOString(), bridged_at: null, ended_at: null }]);
    h.advance(30 * 60_000);
    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, "webhooks").status).toBe("ok");
    expect(check(report, "sessions").status).toBe("ok");
  });

  it("does not hide an unconfirmed bridge behind the optimistic talking state", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", metadata: { recording: { connection: { startedAt: h.now().toISOString(), confirmedAt: null } } } }, row => row.id === sessionId);
    h.advance(6 * 60_000);
    expect(check(await getTelephonyHealth(healthDeps(h)), "webhooks")).toMatchObject({ status: "warn",
      detail: { entries: [expect.objectContaining({ sessionId, reason: "connection_unconfirmed" })] } });
  });

  it.each(["unknown", "unavailable", "ended"] as const)("shows provider %s evidence as a warning, including repaired ended legs", async verdict => {
    const h = createTelephonyHarness();
    const report = await getTelephonyHealth({ ...healthDeps(h), providerVerification: {
      checkedAt: h.now().toISOString(), entries: [{ sessionId: "call-1", state: "talking", verdict, checkedAt: h.now().toISOString(), reconciled: true }], remaining: 0, error: null,
    } });
    expect(check(report, "provider").status).toBe("warn");
    expect(report.status).toBe("warn");
  });

  it("reports an unreconciled positively ended provider leg as failure", async () => {
    const h = createTelephonyHarness();
    const report = await getTelephonyHealth({ ...healthDeps(h), providerVerification: {
      checkedAt: h.now().toISOString(), entries: [{ sessionId: "call-1", state: "talking", verdict: "ended", checkedAt: h.now().toISOString(), reconciled: false }], remaining: 0, error: null,
    } });
    expect(check(report, "provider").status).toBe("fail");
  });

  it.each([
    ["motorist_telephony_settings", "configuration"], ["motorist_call_sessions", "sessions"],
    ["motorist_telnyx_webhook_events", "webhooks"], ["motorist_job_incidents", "incidents"],
    ["motorist_telephony_daily_usage", "usage"], ["motorist_operator_devices", "devices"],
  ])("does not report a failed %s read as healthy", async (table, key) => {
    const h = createTelephonyHarness();
    h.db.failNext(table, "select", "database read unavailable");
    const report = await getTelephonyHealth(healthDeps(h));
    expect(check(report, key)).toMatchObject({ status: "warn", detail: { error: "database read unavailable" } });
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
