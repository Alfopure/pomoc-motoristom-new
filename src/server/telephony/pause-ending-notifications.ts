import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { pauseEndingSchedule, pauseEndingWindowStatus } from "@/lib/telephony/pause-ending";
import type { Database } from "@/lib/supabase/database.types";
import { pauseEndingNotificationEnabled, sendPauseEndingPush } from "@/server/web-push";

type AdminClient = SupabaseClient<Database>;
type PresenceRow = Database["public"]["Tables"]["motorist_operator_presence"]["Row"];

export type PauseEndingMaterializationStatus =
  | "delivered"
  | "duplicate"
  | "disabled"
  | "not_paused"
  | "untimed"
  | "stale"
  | "early"
  | "expired";

export type PauseEndingMaterializationResult = {
  status: PauseEndingMaterializationStatus;
  delivered: boolean;
  notificationId?: string;
  warningAt?: string;
  plannedEndAt?: string;
};

export async function materializePauseEndingNotification(
  supabase: AdminClient,
  input: {
    organizationId: string;
    profileId: string;
    expectedPauseStartedAt?: string | null;
    now?: Date;
  },
): Promise<PauseEndingMaterializationResult> {
  if (!await pauseEndingNotificationEnabled(supabase, { organizationId: input.organizationId, profileId: input.profileId })) {
    return { status: "disabled", delivered: false };
  }

  const presenceResult = await supabase.from("motorist_operator_presence").select("*")
    .eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
  throwOnStorageError(presenceResult.error, "Prezenciu pre upozornenie sa nepodarilo načítať.");
  const presence = presenceResult.data;
  if (!presence || presence.status !== "paused" || !presence.pause_reason_id) {
    return { status: "not_paused", delivered: false };
  }

  const pauseStartedAt = normalizedTimestamp(presence.status_since);
  const expectedPauseStartedAt = input.expectedPauseStartedAt ? normalizedTimestamp(input.expectedPauseStartedAt) : null;
  if (input.expectedPauseStartedAt && (!expectedPauseStartedAt || expectedPauseStartedAt !== pauseStartedAt)) {
    return { status: "stale", delivered: false };
  }

  const reasonResult = await supabase.from("motorist_pause_reasons").select("id,label,max_minutes,active")
    .eq("organization_id", input.organizationId).eq("id", presence.pause_reason_id).maybeSingle();
  throwOnStorageError(reasonResult.error, "Dôvod pauzy pre upozornenie sa nepodarilo načítať.");
  const reason = reasonResult.data;
  const schedule = pauseEndingSchedule({
    status: presence.status,
    statusSince: presence.status_since,
    maxMinutes: reason?.active === false ? null : reason?.max_minutes,
  });
  if (!schedule) return { status: "untimed", delivered: false };

  const windowStatus = pauseEndingWindowStatus(schedule, input.now ?? new Date());
  if (windowStatus !== "due") {
    return { status: windowStatus, delivered: false, warningAt: schedule.warningAt, plannedEndAt: schedule.plannedEndAt };
  }

  // Let an opt-out that raced the schedule/presence reads win before the
  // in-app notification is claimed. Web Push repeats this check at send time.
  if (!await pauseEndingNotificationEnabled(supabase, { organizationId: input.organizationId, profileId: input.profileId })) {
    return { status: "disabled", delivered: false, warningAt: schedule.warningAt, plannedEndAt: schedule.plannedEndAt };
  }

  const title = "Plánovaný koniec pauzy o 1 minútu";
  const body = `Pauza „${reason!.label}“ dosiahne plánovaný čas. Keď budeš pripravený, prepni sa ručne na dostupného.`;
  const dedupeKey = `pause-ending:${input.profileId}:${schedule.pauseStartedAt}`;
  const notificationResult = await supabase.from("motorist_notifications").upsert({
    organization_id: input.organizationId,
    case_id: null,
    task_id: null,
    reminder_id: null,
    recipient_profile_id: input.profileId,
    visibility: "private",
    kind: "system",
    severity: "warning",
    title,
    body,
    status: "unread",
    delivery_status: "in_app",
    dedupe_key: dedupeKey,
    payload: {
      source: "pause_ending_warning",
      pause_reason_id: reason!.id,
      pause_started_at: schedule.pauseStartedAt,
      warning_at: schedule.warningAt,
      planned_end_at: schedule.plannedEndAt,
    },
  }, { onConflict: "organization_id,dedupe_key", ignoreDuplicates: true }).select("id").maybeSingle();
  if (notificationResult.error?.code === "23505") return { status: "duplicate", delivered: false, warningAt: schedule.warningAt, plannedEndAt: schedule.plannedEndAt };
  throwOnStorageError(notificationResult.error, "Upozornenie na koniec pauzy sa nepodarilo uložiť.");
  if (!notificationResult.data) return { status: "duplicate", delivered: false, warningAt: schedule.warningAt, plannedEndAt: schedule.plannedEndAt };

  await sendPauseEndingPush(supabase, {
    organizationId: input.organizationId,
    recipientProfileId: input.profileId,
    notificationId: notificationResult.data.id,
    title,
    body,
  });
  return {
    status: "delivered",
    delivered: true,
    notificationId: notificationResult.data.id,
    warningAt: schedule.warningAt,
    plannedEndAt: schedule.plannedEndAt,
  };
}

/** Strict one-minute window: the five-minute cron is only a fallback and never sends early or after the planned end. */
export async function materializeDuePauseEndingNotifications(
  supabase: AdminClient,
  organizationId: string,
  now = new Date(),
  limit = 50,
) {
  const rows = await supabase.from("motorist_operator_presence").select("*")
    .eq("organization_id", organizationId).eq("status", "paused").order("status_since", { ascending: true }).limit(limit);
  throwOnStorageError(rows.error, "Pauzy pre upozornenia sa nepodarilo načítať.");
  const totals: Record<PauseEndingMaterializationStatus, number> = {
    delivered: 0, duplicate: 0, disabled: 0, not_paused: 0, untimed: 0, stale: 0, early: 0, expired: 0,
  };
  for (const presence of (rows.data ?? []) as PresenceRow[]) {
    const result = await materializePauseEndingNotification(supabase, {
      organizationId,
      profileId: presence.profile_id,
      expectedPauseStartedAt: presence.status_since,
      now,
    });
    totals[result.status] += 1;
  }
  return { checked: rows.data?.length ?? 0, ...totals };
}

function normalizedTimestamp(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function throwOnStorageError(error: unknown, message: string) {
  if (!error) return;
  const detail = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error);
  throw new Error(`${message} ${detail}`);
}
