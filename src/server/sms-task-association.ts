import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SmsPrepareInput } from "@/lib/sms/contracts";
import { SmsWorkflowError } from "./sms-errors";

/** The operator chooses the task. Its editable title/kind never supplies proof. */
export async function validateSmsTaskAssociation(admin: SupabaseClient<Database>, organizationId: string, caseId: string | null, taskId: string, template: SmsPrepareInput["template"]) {
  if (!caseId || (template !== "eta_update" && template !== "location_request")) {
    throw new SmsWorkflowError("Úlohu môžete pripojiť k ETA alebo žiadosti o polohu vo vybranom prípade.", 400);
  }
  const task = await admin.from("motorist_case_tasks").select("id,status")
    .eq("organization_id", organizationId).eq("case_id", caseId).eq("id", taskId).in("status", ["open", "overdue"]).maybeSingle();
  if (task.error) throw new SmsWorkflowError("Úlohu prípadu sa nepodarilo overiť.", 503);
  if (!task.data) throw new SmsWorkflowError("Vyberte otvorenú úlohu s pôvodom v tomto prípade.", 400);
  const origins = await admin.from("motorist_task_origins").select("source_type,source_id,origin_case_id,cancelled_at")
    .eq("organization_id", organizationId).eq("task_id", taskId);
  // The historical schema has no origin relation; the explicit original-case
  // and open-state checks above still apply. Other failures never skip proof.
  if (origins.error?.code === "42P01" || origins.error?.code === "PGRST205") return;
  if (origins.error) throw new SmsWorkflowError("Pôvod úlohy sa nepodarilo overiť.", 503);
  const records = origins.data ?? [];
  if (records.some(origin => origin.cancelled_at || origin.origin_case_id !== caseId || origin.source_type === "callback"
    || (origin.source_type === "location" && template !== "location_request"))) {
    throw new SmsWorkflowError("Úloha už patrí inej systémovej povinnosti.", 409);
  }
  const smsIds = records.filter(origin => origin.source_type === "sms").map(origin => origin.source_id);
  if (!smsIds.length) return;
  const sources = await admin.from("motorist_sms_messages").select("id,template_key,case_id")
    .eq("organization_id", organizationId).in("id", smsIds);
  if (sources.error) throw new SmsWorkflowError("Pôvod SMS úlohy sa nepodarilo overiť.", 503);
  if (sources.data?.length !== smsIds.length || sources.data.some(source => source.template_key !== template || source.case_id !== caseId)) {
    throw new SmsWorkflowError("Úloha už patrí inej SMS povinnosti.", 409);
  }
}
