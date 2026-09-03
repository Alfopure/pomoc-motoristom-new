import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { escapeHtml, sendEmail } from "@/server/email-delivery";

import { getTelephonyHealth, type HealthStatus, type TelephonyHealthCheck, type TelephonyHealthReport } from "./health";
import { usageDay } from "./usage";
import type { TelnyxConfig } from "./telnyx/env";

/**
 * Turns the health report into e-mail, once per problem per day.
 *
 * Everything else in this codebase waits to be asked: the incident row is
 * written, the health route answers, the cron summary is returned to whoever
 * called it. At 03:00 nobody is asking. This job is the only path that reaches
 * a human, so it deliberately errs towards sending — but `motorist_telephony_alerts`
 * keeps a row per (day, check, status), which is what stops a five-minute cron
 * from mailing the same stuck session 288 times.
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
 * `fail`: a warning on the leg cap or on webhook silence during a live call is
 * something you want to hear about *before* it turns into lost calls, while a
 * warning anywhere else is a "look at it today" the health route already shows.
 */
const WARN_WORTHY = new Set(["usage", "webhooks"]);

const SLOVAK_LABELS: Record<string, string> = {
  configuration: "Konfigurácia telefónie",
  sessions: "Zaseknuté hovory",
  webhooks: "Prichádzajúce webhooky",
  ledger: "Webhook ledger",
  incidents: "Otvorené incidenty",
  usage: "Denné využitie",
  devices: "Prehliadačové telefóny",
};

export function alertsFromReport(report: TelephonyHealthReport, day: string): TelephonyAlert[] {
  const alerts: TelephonyAlert[] = [];
  for (const check of report.checks) {
    const notify = check.status === "fail" || (check.status === "warn" && WARN_WORTHY.has(check.key));
    if (!notify) continue;
    alerts.push({ key: `${day}:${check.key}:${check.status}`, check: check.key, status: check.status as TelephonyAlert["status"], detail: check.detail });
  }
  return alerts;
}

function describe(alert: TelephonyAlert): string {
  const label = SLOVAK_LABELS[alert.check] ?? alert.check;
  const prefix = alert.status === "fail" ? "CHYBA" : "Upozornenie";
  return `${prefix} — ${label}: ${JSON.stringify(alert.detail)}`;
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
  const existing = await deps.admin
    .from("motorist_telephony_alerts")
    .select("id, alert_key, sends")
    .eq("organization_id", deps.organizationId)
    .in("alert_key", alerts.map((alert) => alert.key));
  if (existing.error) return { status: "failed", detail: { health: report.status }, error: existing.error.message };

  const seen = new Map((existing.data ?? []).map((row) => [row.alert_key, row]));
  const fresh = alerts.filter((alert) => !seen.has(alert.key));

  for (const [, row] of seen) {
    // Still failing: keep the counter honest for the runbook, send nothing.
    await deps.admin
      .from("motorist_telephony_alerts")
      .update({ last_seen_at: nowIso, sends: Number(row.sends ?? 0) })
      .eq("id", row.id);
  }

  if (fresh.length === 0) return { status: "ok", detail: { health: report.status, alerts: alerts.length, sent: 0, suppressed: alerts.length } };

  const worst: TelephonyAlert["status"] = fresh.some((alert) => alert.status === "fail") ? "fail" : "warn";
  const subject = worst === "fail" ? `[Dispečing] Telefónia hlási chybu (${fresh.length})` : `[Dispečing] Telefónia – upozornenie (${fresh.length})`;
  const lines = fresh.map(describe);
  const send = deps.send ?? sendEmail;

  try {
    await send({
      to: recipient,
      subject,
      text: `${subject}\n\n${lines.join("\n")}\n\nStav: ${report.status}\nČas: ${nowIso}`,
      html: `<p><strong>${escapeHtml(subject)}</strong></p><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>Stav: ${escapeHtml(report.status)}<br>Čas: ${escapeHtml(nowIso)}</p>`,
      // Same key as the ledger row: a retry after a crashed send cannot double-mail.
      idempotencyKey: `telephony-alert-${deps.organizationId}-${fresh.map((alert) => alert.key).join("|")}`.slice(0, 200),
    });
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
