import { MutationError } from "@/server/mutation-error";
import { mapCaseTaskRow } from "@/data/dispatch-repository";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

const MEMBER_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;

/**
 * Incremental poll behind the console's live updates (every 10 s while the
 * tab is visible): customer locations, their notifications and — because the
 * case snapshot is otherwise only reloaded by this tab's own actions — every
 * task somebody in the organisation created or changed since the cursor.
 * Deleted tasks leave no row to report; they disappear with the next full load.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor([...MEMBER_ROLES]);
    const checkedAt = new Date().toISOString();
    const since = parseSince(request.url);
    const supabase = createSupabaseAdminClient();
    const [submissionsResult, notificationsResult, tasksResult] = await Promise.all([
      supabase
        .from("motorist_location_submissions")
        .select("id, case_id, location_id, lat, lng, accuracy_meters, submitted_at")
        .eq("organization_id", actor.organizationId)
        .eq("accepted", true)
        .gt("submitted_at", since)
        .lte("submitted_at", checkedAt)
        .order("submitted_at", { ascending: true })
        .limit(100),
      supabase
        .from("motorist_notifications")
        .select("*")
        .eq("organization_id", actor.organizationId)
        .eq("recipient_profile_id", actor.profileId)
        .like("dedupe_key", "location-submitted:%")
        .gt("created_at", since)
        .lte("created_at", checkedAt)
        .order("created_at", { ascending: true })
        .limit(100),
      supabase
        .from("motorist_case_tasks")
        .select("*")
        .eq("organization_id", actor.organizationId)
        .gt("updated_at", since)
        .lte("updated_at", checkedAt)
        .order("updated_at", { ascending: true })
        .limit(200),
    ]);

    if (submissionsResult.error) throw submissionsResult.error;
    if (notificationsResult.error) throw notificationsResult.error;
    if (tasksResult.error) throw tasksResult.error;

    return Response.json({
      checkedAt,
      tasks: (tasksResult.data ?? []).map((task) => mapCaseTaskRow(task, task.created_at)),
      notifications: (notificationsResult.data ?? []).map((notification) => ({
        id: notification.id,
        caseId: notification.case_id ?? undefined,
        taskId: notification.task_id ?? undefined,
        reminderId: notification.reminder_id ?? undefined,
        recipientProfileId: notification.recipient_profile_id ?? undefined,
        visibility: notification.visibility,
        kind: notification.kind,
        severity: notification.severity,
        title: notification.title,
        body: notification.body ?? undefined,
        status: notification.status,
        deliveryStatus: notification.delivery_status,
        dedupeKey: notification.dedupe_key,
        readAt: notification.read_at ?? undefined,
        archivedAt: notification.archived_at ?? undefined,
        createdAt: notification.created_at,
        updatedAt: notification.updated_at,
      })),
      updates: (submissionsResult.data ?? []).map((submission) => ({
        caseId: submission.case_id,
        event: {
          id: `location-submission:${submission.id}`,
          caseId: submission.case_id,
          time: submission.submitted_at,
          actor: "Klient",
          title: "Poloha od klienta prijatá",
          body: submission.accuracy_meters === null
            ? "Klient odoslal GPS polohu."
            : `Klient odoslal GPS polohu s presnosťou približne ${Math.round(submission.accuracy_meters)} m.`,
          type: "location_submitted",
        },
        location: {
          accuracyMeters: submission.accuracy_meters ?? undefined,
          label: "Poloha od klienta",
          lat: Number(submission.lat),
          lng: Number(submission.lng),
          locationId: submission.location_id ?? undefined,
          submittedAt: submission.submitted_at,
        },
      })),
    });
  } catch (error) {
    if (error instanceof MutationError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Location update poll failed:", error);
    return Response.json({ error: "Nové polohy klientov sa nepodarilo obnoviť." }, { status: 500 });
  }
}

function parseSince(url: string) {
  const raw = new URL(url).searchParams.get("since");
  const timestamp = raw ? Date.parse(raw) : Number.NaN;

  if (!Number.isFinite(timestamp)) {
    return new Date(Date.now() - 5 * 60_000).toISOString();
  }

  return new Date(timestamp).toISOString();
}
