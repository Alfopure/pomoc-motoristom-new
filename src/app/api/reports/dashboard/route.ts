import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import {
  buildReportDashboard,
  resolveReportRange,
  type ReportRangeKey,
  type ReportTaskRow,
} from "@/lib/reporting";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

const REPORT_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
type AdminClient = SupabaseClient<Database>;

export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor([...REPORT_ROLES]);
    const url = new URL(request.url);
    const requestedRange = url.searchParams.get("range");
    const range = resolveReportRange(isReportRange(requestedRange) ? requestedRange : "7d");
    const supabase = createSupabaseAdminClient();

    const [calls, cases, tasks, attendance, profiles] = await Promise.all([
      supabase
        .from("motorist_calls")
        .select("id, status, direction, operator_id, case_id, started_at, answered_at, wait_seconds, duration_seconds")
        .eq("organization_id", actor.organizationId)
        .gte("started_at", range.from)
        .lt("started_at", range.to)
        .order("started_at", { ascending: true })
        .limit(5000),
      supabase
        .from("motorist_cases")
        .select("id, status, priority, source_type, owner_id, vehicle_details, replacement_vehicle_details, created_at, closed_at")
        .eq("organization_id", actor.organizationId)
        .or(`created_at.gte.${range.from},closed_at.gte.${range.from}`)
        .order("created_at", { ascending: true })
        .limit(5000),
      loadReportTasks(supabase, actor.organizationId, range.from),
      supabase
        .from("motorist_attendance_sessions")
        .select("profile_id, started_at, ended_at")
        .eq("organization_id", actor.organizationId)
        .lt("started_at", range.to)
        .or(`ended_at.is.null,ended_at.gte.${range.from}`)
        .limit(5000),
      supabase
        .from("motorist_profiles")
        .select("id, display_name")
        .eq("organization_id", actor.organizationId)
        .order("display_name")
        .limit(500),
    ]);

    throwOnError(calls, "Hovory");
    throwOnError(cases, "Prípady");
    throwOnError(tasks, "Úlohy");
    throwOnError(attendance, "Dochádzka");
    throwOnError(profiles, "Používatelia");

    return Response.json(
      buildReportDashboard({
        range,
        calls: calls.data ?? [],
        cases: cases.data ?? [],
        tasks: tasks.data ?? [],
        attendance: attendance.data ?? [],
        profiles: profiles.data ?? [],
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    return Response.json(
      { error: error instanceof Error ? error.message : "Report sa nepodarilo načítať." },
      { status: 500 },
    );
  }
}

function isReportRange(value: string | null): value is ReportRangeKey {
  return value === "today" || value === "7d" || value === "30d";
}

async function loadReportTasks(supabase: AdminClient, organizationId: string, from: string) {
  const result = await supabase
    .from("motorist_case_tasks")
    .select("assigned_to, completed_by, completed_at, created_at, due_at, status")
    .eq("organization_id", organizationId)
    .or(`status.eq.open,status.eq.overdue,completed_at.gte.${from}`)
    .limit(5000);

  if (!isTaskCompletionSchemaDrift(result.error)) {
    return {
      data: (result.data ?? []) as ReportTaskRow[],
      error: result.error,
    };
  }

  // Older deployments predate task completion metadata. `updated_at` is the
  // closest durable timestamp there, while `assigned_to` remains the best
  // available attribution. This keeps reports usable without a forced migration.
  const legacyResult = await supabase
    .from("motorist_case_tasks")
    .select("assigned_to, created_at, updated_at, due_at, status")
    .eq("organization_id", organizationId)
    .or(`status.eq.open,status.eq.overdue,updated_at.gte.${from}`)
    .limit(5000);

  return {
    data: (legacyResult.data ?? []).map((task) => ({
      assigned_to: task.assigned_to,
      completed_by: null,
      completed_at: task.status === "done" ? task.updated_at : null,
      created_at: task.created_at,
      due_at: task.due_at,
      status: task.status,
    })) satisfies ReportTaskRow[],
    error: legacyResult.error,
  };
}

function isTaskCompletionSchemaDrift(error: { message?: string; code?: string } | null) {
  if (!error) {
    return false;
  }

  const message = String(error.message ?? "").toLowerCase();
  const namesCompletionColumn = message.includes("completed_by") || message.includes("completed_at");
  const isMissingColumn =
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("schema cache") ||
    message.includes("does not exist");

  return namesCompletionColumn && isMissingColumn;
}

function throwOnError(result: { error: { message?: string } | null }, label: string) {
  if (result.error) {
    throw new MutationError(`${label} sa nepodarilo načítať: ${result.error.message ?? "neznáma chyba"}`, 500);
  }
}
