import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";

const BUCKET = "motorist-task-photos";
const missing = (code?: string) => code === "PGRST202" || code === "42883";
export type EmployeeTaskMaintenance = { status: "ok" | "unavailable" | "budget"; recurrences: number; reminders: number; photosRemoved: number; failed: number };
/** Runs inside the existing cron. Every batch is bounded; neither recurrence nor
 * storage cleanup depends on the user's push preference or a working provider. */
export async function maintainEmployeeTasks(organizationId: string, deadline: number, injected?: SupabaseClient): Promise<EmployeeTaskMaintenance> {
  const result: EmployeeTaskMaintenance = { status: "ok", recurrences: 0, reminders: 0, photosRemoved: 0, failed: 0 };
  if (!isUuid(organizationId)) return { ...result, status: "unavailable" };
  if (Date.now() + 2_000 >= deadline) return { ...result, status: "budget" };
  const admin = injected ?? createSupabaseAdminClient(AbortSignal.timeout(Math.min(12_000, Math.max(1, deadline - Date.now())))) as unknown as SupabaseClient;
  const tick = await admin.rpc("motorist_employee_tasks_tick", { p_organization_id: organizationId, p_limit: 20 }).abortSignal(AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))));
  if (tick.error) {
    if (missing(tick.error.code)) return { ...result, status: "unavailable" };
    result.failed++;
  } else {
    const data = tick.data as Record<string, unknown> | null;
    if (data && Number.isSafeInteger(data.recurrences) && (data.recurrences as number) >= 0 && Number.isSafeInteger(data.reminders) && (data.reminders as number) >= 0) {
      result.recurrences = data.recurrences as number; result.reminders = data.reminders as number;
      if (data.failed !== undefined) {
        if (Number.isSafeInteger(data.failed) && (data.failed as number) >= 0) result.failed += data.failed as number;
        else result.failed++;
      }
    } else result.failed++;
  }
  if (Date.now() + 2_000 >= deadline) return { ...result, status: "budget" };
  const cleanup = await admin.rpc("motorist_employee_tasks_cleanup", { p_organization_id: organizationId, p_limit: 5 }).abortSignal(AbortSignal.timeout(Math.min(4_000, Math.max(1, deadline - Date.now()))));
  if (cleanup.error) { if (!missing(cleanup.error.code)) result.failed++; return result; }
  if (!Array.isArray(cleanup.data) || cleanup.data.length > 5) { result.failed++; return result; }
  const safe = cleanup.data.filter((row): row is { id: string; bucket: string; path: string } =>
    row && typeof row === "object" && isUuid(row.id) && row.bucket === BUCKET && typeof row.path === "string"
    && new RegExp(`^${organizationId}/[0-9a-f-]{36}/${row.id}\\.(?:jpg|jpeg|png)$`).test(row.path));
  if (safe.length !== cleanup.data.length) { result.failed++; return result; }
  if (!safe.length) return result;
  if (Date.now() + 2_000 >= deadline) return { ...result, status: "budget" };
  const removed = await admin.storage.from(BUCKET).remove(safe.map(row => row.path));
  if (removed.error) { result.failed++; return result; }
  const finished = await admin.rpc("motorist_employee_tasks_cleanup_finish", { p_organization_id: organizationId, p_ids: safe.map(row => row.id) }).abortSignal(AbortSignal.timeout(Math.min(3_000, Math.max(1, deadline - Date.now()))));
  if (finished.error || !Number.isSafeInteger(finished.data) || (finished.data as number) < 0 || (finished.data as number) > safe.length) result.failed++;
  else result.photosRemoved = finished.data as number;
  return result;
}
