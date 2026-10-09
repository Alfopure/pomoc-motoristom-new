import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { resolveAppEnvironment, type AppEnvironment } from "@/lib/app-environment";
import type { Database } from "@/lib/supabase/database.types";
import { sendEmail } from "@/server/email-delivery";

import { getTelephonyHealth, type HealthStatus, type TelephonyHealthCheck, type TelephonyHealthReport } from "./health";
import { usageDay } from "./usage";
import type { TelnyxConfig } from "./telnyx/env";
import { alertObject, alertSessionIds, loadTelephonyAlertEvidence } from "./alert-evidence";
import { renderTelephonyAlertEmail } from "./alert-email";

/**
 * Turns the health report into e-mail, once per identified incident/severity.
 *
 * Everything else in this codebase waits to be asked: the incident row is
 * written, the health route answers, the cron summary is returned to whoever
 * called it. At 03:00 nobody is asking. This job is the only path that reaches
 * a human, so it deliberately errs towards sending — but `motorist_telephony_alerts`
 * keeps a row per stable event or job opening. Unscoped checks and session
 * progress retain a daily key; the same failed event is not new at midnight.
 *
 * A worsening problem is a new key (`…:warn` → `…:fail`), so an escalation is
 * always delivered even though the warning was already sent.
 */

type AdminClient = SupabaseClient<Database>;

export type TelephonyAlertDeps = {
  admin: AdminClient;
  organizationId: string;
  config: Pick<TelnyxConfig, "configured">;
  now?: () => Date;
  /** Test seam; defaults to the Resend-backed transport. */
  send?: (message: { to: string; subject: string; text: string; html: string; idempotencyKey: string }) => Promise<unknown>;
  /** Test seam; defaults to `ALERT_EMAIL_TO`. */
  recipient?: string | null;
  /** Test seam; defaults to the live health report. */
  report?: TelephonyHealthReport;
  /** Application environment, independent of Vercel's Production target. */
  environment?: AppEnvironment | "unknown";
};

export type TelephonyAlert = {
  key: string;
  check: string;
  status: Exclude<HealthStatus, "ok" | "skipped">;
  detail: Record<string, unknown>;
};

export type TelephonyAlertResult = {
  status: "ok" | "skipped" | "failed";
  detail: Record<string, unknown>;
  error?: string;
};

/**
 * Checks that are worth waking somebody for at `warn`. The rest only alert at
 * `fail`: a warning on the leg cap or a missing expected event is
 * something you want to hear about *before* it turns into lost calls, while a
 * warning anywhere else is a "look at it today" the health route already shows.
 */
const WARN_WORTHY = new Set(["usage", "webhooks", "provider", "connections"]);

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Scope alerts by stable incident identity: a different caller later today must still be reported. */
function scopedAlerts(alert: TelephonyAlert, checkedAt: string): TelephonyAlert[] {
  if (alert.check === "interruptions") {
    // One operator departure is one episode, even across midnight; another leg
    // of the same call must still be reportable. Never mail incomplete evidence.
    return (Array.isArray(alert.detail.entries) ? alert.detail.entries : []).map(alertObject)
      .filter(entry => entry.classification === "interruption_observed" &&
        ["production", "test"].includes(String(entry.environment)) && entry.environment === alert.detail.environment &&
        [entry.incidentId, entry.legId, entry.sessionId].every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))
      .map(entry => ({ ...alert, key: `interruptions:${entry.environment}:${digest(`${entry.incidentId}:${entry.legId}`).slice(0, 24)}`,
        detail: { ...alert.detail, confirmed: 1, entries: [entry], sessionIds: [entry.sessionId] } }));
  }
  // A connection report also contains repaired historical failures. They are
  // context, not new failing calls to notify about independently.
  if (alert.check === "connections" && Array.isArray(alert.detail.entries)) {
    const entries = alert.detail.entries.filter((value) => {
      const entry = alertObject(value);
      return ["unknown", "ended_without_confirmation"].includes(String(entry.outcome)) ||
        entry.outcome === "pending" && (typeof entry.failedAt !== "string" || Date.parse(checkedAt) - Date.parse(entry.failedAt) >= 30_000);
    });
    alert = { ...alert, detail: { ...alert.detail, entries, sessionIds: entries.map((entry) => alertObject(entry).sessionId) } };
  }
  if (alert.check === "provider" && Array.isArray(alert.detail.entries)) {
    const entries = alert.detail.entries.filter((entry) => alertObject(entry).verdict !== "alive");
    alert = { ...alert, detail: { ...alert.detail, entries, sessionIds: entries.map((entry) => alertObject(entry).sessionId) } };
  }
  const sessionIds = alertSessionIds(alert);
  if (sessionIds.length) return sessionIds.map((sessionId) => {
    const entries = Array.isArray(alert.detail.entries) ? alert.detail.entries.filter((entry) => alertObject(entry).sessionId === sessionId) : null;
    const reasons = [...new Set((entries ?? []).map(alertObject).map((entry) => `${String(entry.verdict ?? entry.outcome ?? "")}:${String(entry.reason ?? "")}`))].sort().join("|");
    return { ...alert,
      key: `${alert.key}:${digest(`session:${sessionId}:${reasons}`).slice(0, 24)}`,
      detail: { ...alert.detail, sessionIds: [sessionId],
      ...(Array.isArray(alert.detail.stuckIds) ? { stuckIds: [sessionId] } : {}),
        ...(entries ? { entries } : {}),
      },
    };
  });
  const eventIds = alert.check === "ledger" && Array.isArray(alert.detail.failedIds)
    ? [...new Set(alert.detail.failedIds.filter((id): id is string => typeof id === "string"))] : [];
  if (eventIds.length) return eventIds.map((eventId) => ({ ...alert,
    // Event IDs identify the same incident across midnight; usage still has a daily key.
    key: `ledger:${alert.status}:${digest(`event:${eventId}`).slice(0, 24)}`, detail: { ...alert.detail, failedIds: [eventId],
      ...(Array.isArray(alert.detail.failures) ? { failures: alert.detail.failures.filter(failure => alertObject(failure).eventId === eventId) } : {}),
    },
  }));
  const jobs = alert.check === "incidents" && Array.isArray(alert.detail.jobs) ? alert.detail.jobs.map(alertObject) : [];
  if (jobs.length && jobs.every((job) => typeof job.job === "string" && typeof job.openedAt === "string")) {
    return jobs.map((job) => ({ ...alert, key: `incidents:${alert.status}:${digest(`job:${job.job}:${job.openedAt}`).slice(0, 24)}`, detail: { ...alert.detail, jobs: [job] } }));
  }
  return [alert];
}

export function alertsFromReport(report: TelephonyHealthReport, day: string): TelephonyAlert[] {
  const alerts: TelephonyAlert[] = [];
  for (const check of report.checks) {
    if (check.key === "interruptions" && check.status !== "fail") continue;
    const notify = check.status === "fail" || (check.status === "warn" && (WARN_WORTHY.has(check.key) || Boolean(check.detail.error)));
    if (!notify) continue;
    alerts.push(...scopedAlerts({ key: `${day}:${check.key}:${check.status}`, check: check.key, status: check.status as TelephonyAlert["status"], detail: check.detail }, report.checkedAt));
  }
  return alerts;
}

export async function runTelephonyAlerts(deps: TelephonyAlertDeps): Promise<TelephonyAlertResult> {
  const now = deps.now?.() ?? new Date();
  const recipient = (deps.recipient === undefined ? process.env.ALERT_EMAIL_TO : deps.recipient)?.trim() || null;
  const report = deps.report ?? (await getTelephonyHealth({ admin: deps.admin, organizationId: deps.organizationId, config: deps.config, now: () => now }));
  const alerts = alertsFromReport(report, usageDay(now));

  if (alerts.length === 0) return { status: "ok", detail: { health: report.status, alerts: 0, sent: 0 } };
  // Without a recipient the ledger would fill with rows nobody was ever told
  // about, and the first configured address would then see none of them.
  if (!recipient) return { status: "skipped", detail: { health: report.status, alerts: alerts.length, sent: 0, reason: "no_recipient" } };

  const nowIso = now.toISOString();
  const seen = new Map<string, { id: string; alert_key: string; sends: number }>();
  // Scoped ledger incidents can exceed the safe PostgREST URL length in one IN.
  for (let offset = 0; offset < alerts.length; offset += 50) {
    const existing = await deps.admin.from("motorist_telephony_alerts").select("id, alert_key, sends")
      .eq("organization_id", deps.organizationId).in("alert_key", alerts.slice(offset, offset + 50).map((alert) => alert.key));
    if (existing.error) return { status: "failed", detail: { health: report.status }, error: existing.error.message };
    for (const row of existing.data ?? []) seen.set(row.alert_key, row);
  }
  const fresh = alerts.filter((alert) => !seen.has(alert.key));

  const seenIds = [...seen.values()].map((row) => row.id);
  for (let offset = 0; offset < seenIds.length; offset += 50) {
    // Still failing: update observation time, preserving the actual send count.
    await deps.admin.from("motorist_telephony_alerts").update({ last_seen_at: nowIso })
      .eq("organization_id", deps.organizationId).in("id", seenIds.slice(offset, offset + 50));
  }

  if (fresh.length === 0) return { status: "ok", detail: { health: report.status, alerts: alerts.length, sent: 0, suppressed: alerts.length } };

  const evidence = await loadTelephonyAlertEvidence({ admin: deps.admin, organizationId: deps.organizationId, alerts: fresh });
  let environment = deps.environment;
  if (!environment) {
    try { environment = resolveAppEnvironment(); } catch { environment = "unknown"; }
  }
  const message = renderTelephonyAlertEmail({ alerts: fresh, report, evidence, environment });
  const send = deps.send ?? sendEmail;

  try {
    const delivery = await send({
      to: recipient,
      ...message,
      // TEST snapshots retain production organization/incident IDs. Separate
      // provider keys even when both environments use the same Resend account.
      idempotencyKey: `telephony-alert-${environment}-${deps.organizationId}-${digest(fresh.map((alert) => alert.key).sort().join("|"))}`,
    });
    const deliveryStatus = alertObject(delivery).status;
    if (deliveryStatus === "failed" || deliveryStatus === "disabled") return {
      status: "failed", detail: { health: report.status, alerts: alerts.length, sent: 0, deliveryStatus },
      error: typeof alertObject(delivery).error === "string" ? String(alertObject(delivery).error) : `email_${deliveryStatus}`,
    };
  } catch (error) {
    return { status: "failed", detail: { health: report.status, alerts: alerts.length, sent: 0 }, error: error instanceof Error ? error.message : String(error) };
  }

  const inserted = await deps.admin.from("motorist_telephony_alerts").insert(
    fresh.map((alert) => ({
      organization_id: deps.organizationId,
      alert_key: alert.key,
      status: alert.status,
      detail: alert.detail as Database["public"]["Tables"]["motorist_telephony_alerts"]["Row"]["detail"],
      sends: 1,
      first_sent_at: nowIso,
      last_sent_at: nowIso,
      last_seen_at: nowIso,
    })),
  );
  if (inserted.error) {
    // The mail is already out; failing loudly here is better than silently
    // arming a repeat on the next tick.
    return { status: "failed", detail: { health: report.status, alerts: alerts.length, sent: fresh.length }, error: inserted.error.message };
  }

  return { status: "ok", detail: { health: report.status, alerts: alerts.length, sent: fresh.length, suppressed: alerts.length - fresh.length, keys: fresh.map((alert) => alert.key) } };
}

export type { TelephonyHealthCheck };
