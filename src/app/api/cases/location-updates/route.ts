import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

const MEMBER_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;

export async function GET(request: Request) {
  const denied = await motoristAccessGuard({ roles: [...MEMBER_ROLES] });
  if (denied) return denied;

  try {
    const actor = await requireDefaultMotoristActor([...MEMBER_ROLES]);
    const checkedAt = new Date().toISOString();
    const since = parseSince(request.url);
    const supabase = createSupabaseAdminClient();
    const [submissionsResult, notificationsResult] = await Promise.all([
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
    ]);

    if (submissionsResult.error) throw submissionsResult.error;
    if (notificationsResult.error) throw notificationsResult.error;

    return Response.json({
      checkedAt,
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
