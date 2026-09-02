import "server-only";

import type { Json } from "@/lib/supabase/database.types";
import type { JobDefinition, JobName } from "@/server/jobs/types";
import { escapeHtml, sendEmail } from "@/server/email-delivery";
import type { RunLedger } from "./run-ledger";

export async function recordJobFailure(
  ledger: RunLedger,
  definition: JobDefinition,
  errorSafe: string,
) {
  const recent = await ledger.client
    .from("motorist_job_runs")
    .select("status")
    .eq("job_name", definition.name)
    .order("scheduled_for", { ascending: false })
    .limit(definition.failureThreshold);

  if (recent.error) throw new Error(recent.error.message);
  const failedCount = consecutiveFailures(recent.data ?? []);
  if (failedCount < definition.failureThreshold) return;

  const disabled = await ledger.disableJob(definition.name);

  const existing = await ledger.client
    .from("motorist_job_incidents")
    .select("incident_id")
    .eq("job_name", definition.name)
    .eq("status", "open")
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return;

  const now = new Date().toISOString();
  const inserted = await ledger.client
    .from("motorist_job_incidents")
    .insert({
      job_name: definition.name,
      status: "open",
      consecutive_failures: failedCount,
      opened_at: now,
      last_alert_at: now,
      last_error_safe: errorSafe,
      updated_at: now,
    })
    .select("incident_id")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);

  await sendIncidentEmail("down", definition.name, errorSafe, inserted.data.incident_id, disabled);
}

export async function recordJobRecovery(ledger: RunLedger, jobName: JobName) {
  const existing = await ledger.client
    .from("motorist_job_incidents")
    .select("incident_id")
    .eq("job_name", jobName)
    .eq("status", "open")
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) return;

  const now = new Date().toISOString();
  const updated = await ledger.client
    .from("motorist_job_incidents")
    .update({
      status: "recovered",
      recovered_at: now,
      updated_at: now,
    })
    .eq("incident_id", existing.data.incident_id);
  if (updated.error) throw new Error(updated.error.message);

  await sendIncidentEmail("recovered", jobName, null, existing.data.incident_id, false);
}

async function sendIncidentEmail(
  status: "down" | "recovered",
  jobName: JobName,
  errorSafe: string | null,
  incidentId: string,
  autoDisabled: boolean,
) {
  const recipient = process.env.ALERT_EMAIL_TO?.trim();
  if (!recipient) return;

  const down = status === "down";
  const subject = down && autoDisabled
    ? `[Dispečing] Job ${jobName} bol po chybách vypnutý`
    : down
      ? `[Dispečing] Zlyháva job ${jobName}`
    : `[Dispečing] Obnovený job ${jobName}`;
  const detail = errorSafe ? `\nChyba: ${errorSafe}` : "";
  const disabledDetail = autoDisabled ? "\nPlánovanie tohto jobu bolo automaticky vypnuté; pred opätovným zapnutím ho treba ručne overiť." : "";
  await sendEmail({
    to: recipient,
    subject,
    text: `${subject}\nIncident: ${incidentId}${detail}${disabledDetail}`,
    html: `<p><strong>${escapeHtml(subject)}</strong></p><p>Incident: ${escapeHtml(incidentId)}</p>${
      errorSafe ? `<p>Chyba: ${escapeHtml(errorSafe)}</p>` : ""
    }${autoDisabled ? "<p>Plánovanie tohto jobu bolo automaticky vypnuté; pred opätovným zapnutím ho treba ručne overiť.</p>" : ""}`,
    idempotencyKey: `worker-${incidentId}-${status}`,
  });
}

export function consecutiveFailures(runs: Array<{ status: string }>) {
  let count = 0;
  for (const run of runs) {
    if (run.status !== "failed" && run.status !== "dead") break;
    count += 1;
  }
  return count;
}

export function safeJobResult(status: "success" | "skipped", summarySafe: Json): Json {
  return { status, summary: summarySafe };
}
