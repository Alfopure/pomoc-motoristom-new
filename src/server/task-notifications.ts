import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNotificationDedupeKey, buildTaskNotificationText, notificationKindForTask, notificationSeverityForTask } from "@/domain/notifications";
import type { CaseTask } from "@/domain/types";
import type { Database } from "@/lib/supabase/database.types";
import { buildAppUrl, escapeHtml, sendEmail } from "./email-delivery";
import { sendTaskPush } from "./web-push";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type CaseRow = Tables["motorist_cases"]["Row"];
type CaseTaskRow = Tables["motorist_case_tasks"]["Row"];
type ProfileRow = Tables["motorist_profiles"]["Row"];
type TaskReminderRow = Tables["motorist_task_reminders"]["Row"];
type ReminderChannel = "in_app" | "email";

export async function createDefaultTaskReminder(
  supabase: AdminClient,
  input: {
    organizationId: string;
    caseId: string | null;
    task: Pick<CaseTaskRow, "id" | "assigned_to" | "due_at"> & { reminder_at?: string | null };
    createdBy?: string | null;
    channels?: ReminderChannel[];
  },
) {
  if (!input.task.due_at && !input.task.reminder_at) return null;
  // The task transaction owns generation/cancellation. Retrying this bridge
  // cannot revive a cancelled generation or allocate duplicate recipients.
  const result = await supabase.rpc("motorist_ensure_task_reminders", {
    p_organization_id: input.organizationId, p_task_id: input.task.id,
    p_actor_id: input.createdBy ?? null,
    p_channels: input.channels ? normalizeChannels(input.channels) : null,
  });
  throwOnSupabaseError(result);
  return result.data;
}

/**
 * Assignment is actionable immediately, independently of the due-date reminder.
 * The unread notification also drives the task highlight until the assignee opens it.
 */
export async function createTaskAssignmentNotification(
  supabase: AdminClient,
  input: {
    organizationId: string;
    caseId: string | null;
    task: Pick<CaseTaskRow, "id" | "assigned_to" | "created_at" | "due_at" | "kind" | "priority" | "status" | "title" | "updated_at">;
  },
) {
  if (!input.task.assigned_to || input.task.status === "done") return null;
  // The database owns the stable assignment generation and bell event. This
  // adapter repairs/reuses that event, never inserts a timestamp-keyed duplicate.
  const result = await supabase.rpc("motorist_ensure_task_assignment", { p_organization_id: input.organizationId, p_task_id: input.task.id });
  throwOnSupabaseError(result);
  await deliverTaskAssignmentNotifications(supabase, input.organizationId, input.task.id);
  return result.data;
}

/** Durable assignment outbox; also drained by the existing reminder cron/poll.
 * External delivery is at least once after an ambiguous crash, with the stable
 * notification ID used as the browser tag. Bell insertion itself is exactly once. */
export async function deliverTaskAssignmentNotifications(supabase: AdminClient, organizationId: string, taskId?: string) {
  const claimed = await supabase.rpc("motorist_claim_task_assignments", { p_organization_id: organizationId, p_task_id: taskId ?? null, p_limit: 50 });
  throwOnSupabaseError(claimed);
  const jobs = claimed.data as unknown as Array<{ notificationId: string; taskId: string; recipientProfileId: string; leaseId: string; title: string; body: string }>;
  if (!Array.isArray(jobs)) throw new Error("Assignment delivery response unavailable");
  const totals = { processed: 0, sent: 0, failed: 0 };
  for (const job of jobs) {
    let success = false;
    try {
      const delivery = await sendTaskPush(supabase, { organizationId, recipientProfileId: job.recipientProfileId,
        notificationId: job.notificationId, taskId: job.taskId, title: job.title, body: job.body });
      success = delivery.failed === 0;
    } catch { /* The durable lease is completed as retryable below. */ }
    const finished = await supabase.rpc("motorist_finish_task_assignment", { p_organization_id: organizationId,
      p_notification_id: job.notificationId, p_lease_id: job.leaseId, p_success: success });
    throwOnSupabaseError(finished);
    totals.processed += 1;
    if (success) totals.sent += 1; else totals.failed += 1;
  }
  return totals;
}

/**
 * Vráti kanály poslednej pripomienky úlohy, aby sa pri zmene termínu alebo riešiteľa
 * nestratila voľba emailovej pripomienky. Pri chýbajúcej schéme alebo bez záznamu vráti null.
 */
export async function latestTaskReminderChannels(supabase: AdminClient, organizationId: string, taskId: string): Promise<ReminderChannel[] | null> {
  const result = await supabase
    .from("motorist_task_reminders")
    .select("channels")
    .eq("organization_id", organizationId)
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isTaskReminderSchemaMiss(result.error)) {
    return null;
  }

  throwOnSupabaseError(result);
  const channels = result.data?.channels;

  if (!Array.isArray(channels)) {
    return null;
  }

  const normalized = channels.filter((channel): channel is ReminderChannel => channel === "in_app" || channel === "email");
  return normalized.length > 0 ? normalized : null;
}

export async function cancelPendingTaskReminders(supabase: AdminClient, organizationId: string, taskId: string) {
  // The task trigger already cancelled old work atomically. An old adapter
  // must not cancel the newly created generation after that transaction.
  const result = await supabase.rpc("motorist_cancel_stale_task_reminders", { p_organization_id: organizationId, p_task_id: taskId });
  throwOnSupabaseError(result);
}

export async function materializeDueTaskReminders(supabase: AdminClient, organizationId: string, now = new Date(), limit = 50) {
  await deliverTaskAssignmentNotifications(supabase, organizationId);
  await recoverStaleProcessingReminders(supabase, organizationId, now);

  const dueResult = await supabase
    .from("motorist_task_reminders")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  throwOnSupabaseError(dueResult);

  const reminders = (dueResult.data ?? []).filter((reminder) => isBackoffElapsed(reminder, now));

  if (reminders.length === 0) {
    return { processed: 0, sent: 0, cancelled: 0, failed: 0 };
  }

  const tasksById = await loadTasksById(
    supabase,
    organizationId,
    reminders.map((reminder) => reminder.task_id),
  );
  const casesById = await loadCasesById(
    supabase,
    organizationId,
    reminders.map((reminder) => reminder.case_id).filter((id): id is string => Boolean(id)),
  );
  const profilesById = await loadProfilesById(
    supabase,
    organizationId,
    reminders.map((reminder) => reminder.recipient_profile_id).filter((id): id is string => Boolean(id)),
    reminders.some((reminder) => reminder.visibility === "team"),
  );

  const totals = { processed: 0, sent: 0, cancelled: 0, failed: 0 };

  for (const reminder of reminders) {
    totals.processed += 1;

    const task = tasksById.get(reminder.task_id);

    if (!task || !isCurrentTaskReminder(reminder, task)) {
      await updateReminderStatus(supabase, organizationId, reminder.id, "cancelled", now);
      totals.cancelled += 1;
      continue;
    }

    if (reminder.visibility === "private" && (!reminder.recipient_profile_id || !profilesById.has(reminder.recipient_profile_id))) {
      await updateReminderStatus(supabase, organizationId, reminder.id, "cancelled", now);
      totals.cancelled += 1;
      continue;
    }
    const locked = await lockReminder(supabase, organizationId, reminder.id, now);

    if (!locked) {
      continue;
    }

    const caseRow = reminder.case_id ? casesById.get(reminder.case_id) : undefined;
    const profile = reminder.recipient_profile_id ? profilesById.get(reminder.recipient_profile_id) : undefined;
    const recipients = reminder.visibility === "private" ? (profile ? [profile] : [])
      : [...profilesById.values()].filter((recipient) => !task.assigned_to || task.assigned_to === recipient.id);
    const deliveries = [];
    for (const recipientProfile of recipients) {
      deliveries.push(await createNotificationForReminder({ supabase, organizationId, reminder, task, caseRow, recipientProfile, now }));
    }
    const failure = deliveries.find((delivery) => !delivery.ok);
    const delivery = failure ?? { ok: true as const };

    if (delivery.ok) {
      await updateReminderStatus(supabase, organizationId, reminder.id, "sent", now);
      totals.sent += 1;
    } else {
      const nextAttempts = reminder.attempt_count + 1;
      await updateReminderFailure(supabase, organizationId, reminder, delivery.error, nextAttempts, now);
      totals.failed += nextAttempts >= reminder.max_attempts ? 1 : 0;
    }
  }

  return totals;
}

async function recoverStaleProcessingReminders(supabase: AdminClient, organizationId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - 10 * 60_000).toISOString();
  const result = await supabase
    .from("motorist_task_reminders")
    .update({ status: "pending", last_error: "Recovered stale processing reminder" })
    .eq("organization_id", organizationId)
    .eq("status", "processing")
    .lt("last_attempt_at", staleBefore);

  throwOnSupabaseError(result);
}

async function createNotificationForReminder(input: {
  supabase: AdminClient;
  organizationId: string;
  reminder: TaskReminderRow;
  task: CaseTaskRow;
  caseRow?: CaseRow;
  recipientProfile?: ProfileRow;
  now: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const taskView = mapTaskRow(input.task);
  const dedupeKey = buildNotificationDedupeKey({
    taskId: input.task.id,
    reminderId: input.reminder.id,
    recipientProfileId: input.recipientProfile?.id,
    scheduledFor: input.reminder.scheduled_for,
  });
  const text = buildTaskNotificationText(taskView, input.caseRow?.case_number);
  const notificationResult = await input.supabase
    .from("motorist_notifications")
    .upsert({
      organization_id: input.organizationId,
      case_id: input.reminder.case_id,
      task_id: input.task.id,
      reminder_id: input.reminder.id,
      recipient_profile_id: input.recipientProfile!.id,
      visibility: "private",
      kind: notificationKindForTask(taskView, input.now),
      severity: notificationSeverityForTask(taskView, input.now),
      title: text.title,
      body: text.body,
      status: "unread",
      delivery_status: "in_app",
      dedupe_key: dedupeKey,
      payload: {
        source: "task_reminder_runner",
        scheduled_for: input.reminder.scheduled_for,
        channels: input.reminder.channels,
        generation: input.reminder.generation ?? 0,
      },
    }, { onConflict: "organization_id,dedupe_key", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();

  if (isDuplicateError(notificationResult.error)) {
    return { ok: true };
  }

  if (isNotificationSchemaMiss(notificationResult.error)) {
    return { ok: true };
  }

  if (notificationResult.error) {
    return { ok: false, error: notificationResult.error.message };
  }

  if (!notificationResult.data) {
    return { ok: true };
  }

  // Insert/SQL generation validation precedes all external side effects.
  // A duplicate generation is already delivered, so it never sends again.
  if (input.reminder.channels.includes("email")) {
    const email = await maybeSendReminderEmail({ reminder: input.reminder, task: taskView, caseRow: input.caseRow, recipientProfile: input.recipientProfile, dedupeKey });
    const updated = await input.supabase.from("motorist_notifications").update({
      delivery_status: email.status === "sent" ? "email_sent" : email.status === "failed" ? "email_failed" : "in_app",
      payload: { source: "task_reminder_runner", scheduled_for: input.reminder.scheduled_for, channels: input.reminder.channels, generation: input.reminder.generation ?? 0, email },
    }).eq("organization_id", input.organizationId).eq("id", notificationResult.data.id);
    throwOnSupabaseError(updated);
  }

  await sendTaskPush(input.supabase, {
    organizationId: input.organizationId, recipientProfileId: input.recipientProfile!.id,
    notificationId: notificationResult.data.id, taskId: input.task.id, title: text.title, body: text.body,
  });
  return { ok: true };
}

async function maybeSendReminderEmail(input: {
  reminder: TaskReminderRow;
  task: CaseTask;
  caseRow?: CaseRow;
  recipientProfile?: ProfileRow;
  dedupeKey: string;
}): Promise<{ status: "not_requested" | "sent" | "failed" | "disabled"; error?: string | null; provider?: string; messageId?: string | null }> {
  if (!input.reminder.channels.includes("email")) {
    return { status: "not_requested" };
  }

  if (!input.recipientProfile?.email) {
    return { status: "failed", error: "Recipient email is not configured" };
  }

  const caseNumber = input.caseRow?.case_number ?? "prípad";
  const url = buildAppUrl(`/?task=${encodeURIComponent(input.task.id)}`);
  const subject = `${caseNumber}: ${input.task.title}`;
  const text = `${input.task.title}\nTermín: ${input.task.dueAt || "bez termínu"}\n${url}`;
  const html = `<p><strong>${escapeHtml(input.task.title)}</strong></p><p>Termín: ${escapeHtml(input.task.dueAt || "bez termínu")}</p><p><a href="${escapeHtml(url)}">Otvoriť dispečing</a></p>`;
  const result = await sendEmail({
    to: input.recipientProfile.email,
    subject,
    text,
    html,
    idempotencyKey: input.dedupeKey,
  });

  return {
    status: result.status,
    provider: result.provider,
    messageId: result.messageId ?? null,
    error: result.error,
  };
}

async function lockReminder(supabase: AdminClient, organizationId: string, reminderId: string, now: Date) {
  const result = await supabase
    .from("motorist_task_reminders")
    .update({ status: "processing", last_attempt_at: now.toISOString(), last_error: null })
    .eq("organization_id", organizationId)
    .eq("id", reminderId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  throwOnSupabaseError(result);
  return Boolean(result.data);
}

async function updateReminderStatus(supabase: AdminClient, organizationId: string, reminderId: string, status: TaskReminderRow["status"], now: Date) {
  if (status === "cancelled") {
    const result = await supabase.rpc("motorist_cancel_unavailable_reminder", { p_organization_id: organizationId, p_reminder_id: reminderId });
    throwOnSupabaseError(result);
    return;
  }
  const result = await supabase
    .from("motorist_task_reminders")
    .update({ status, last_attempt_at: now.toISOString(), last_error: null })
    .eq("organization_id", organizationId)
    .eq("id", reminderId)
    .eq("status", "processing");

  throwOnSupabaseError(result);
}

async function updateReminderFailure(supabase: AdminClient, organizationId: string, reminder: TaskReminderRow, error: string, attemptCount: number, now: Date) {
  const result = await supabase
    .from("motorist_task_reminders")
    .update({
      status: attemptCount >= reminder.max_attempts ? "failed" : "pending",
      attempt_count: attemptCount,
      last_attempt_at: now.toISOString(),
      last_error: error,
    })
    .eq("organization_id", organizationId)
    .eq("id", reminder.id)
    .eq("status", "processing");

  throwOnSupabaseError(result);
}

async function loadTasksById(supabase: AdminClient, organizationId: string, taskIds: string[]) {
  const ids = unique(taskIds);

  if (ids.length === 0) {
    return new Map<string, CaseTaskRow>();
  }

  const result = await supabase.from("motorist_case_tasks").select("*").eq("organization_id", organizationId).in("id", ids);
  throwOnSupabaseError(result);

  return new Map((result.data ?? []).map((task) => [task.id, task]));
}

async function loadCasesById(supabase: AdminClient, organizationId: string, caseIds: string[]) {
  const ids = unique(caseIds);

  if (ids.length === 0) {
    return new Map<string, CaseRow>();
  }

  const result = await supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).in("id", ids);
  throwOnSupabaseError(result);

  return new Map((result.data ?? []).map((caseRow) => [caseRow.id, caseRow]));
}

async function loadProfilesById(supabase: AdminClient, organizationId: string, profileIds: string[], includeTeam = false) {
  const ids = unique(profileIds);

  if (ids.length === 0 && !includeTeam) {
    return new Map<string, ProfileRow>();
  }

  const query = supabase.from("motorist_profiles").select("*").eq("organization_id", organizationId).eq("active", true).in("role", ["dispatcher", "senior_dispatcher", "manager", "admin"]);
  const result = await (includeTeam ? query : query.in("id", ids));
  throwOnSupabaseError(result);

  return new Map((result.data ?? []).map((profile) => [profile.id, profile]));
}

function mapTaskRow(task: CaseTaskRow): CaseTask {
  return {
    id: task.id,
    caseId: task.case_id ?? "",
    title: task.title,
    assignedTo: task.assigned_to ?? "unassigned",
    dueAt: task.due_at ?? "",
    status: task.status,
    priority: task.priority ?? "normal",
    kind: task.kind ?? "other",
    createdBy: task.created_by ?? undefined,
    completedBy: task.completed_by ?? undefined,
    completedAt: task.completed_at ?? undefined,
  };
}

export function isCurrentTaskReminder(reminder: Pick<TaskReminderRow, "generation" | "visibility" | "recipient_profile_id" | "scheduled_for" | "payload">, task: Pick<CaseTaskRow, "status" | "assigned_to" | "due_at" | "reminder_generation"> & { reminder_at?: string | null }) {
  if (task.status === "done" || (reminder.generation ?? 0) !== (task.reminder_generation ?? 0)) return false;
  if (task.assigned_to && reminder.visibility === "private" && reminder.recipient_profile_id !== task.assigned_to) return false;
  const source = reminder.payload && typeof reminder.payload === "object" && !Array.isArray(reminder.payload) ? reminder.payload.source : null;
  return (source !== "task_default_reminder" && source !== "task_custom_reminder") || new Date(reminder.scheduled_for).getTime() === new Date(task.reminder_at ?? task.due_at ?? "").getTime();
}

function isBackoffElapsed(reminder: TaskReminderRow, now: Date) {
  if (!reminder.last_attempt_at || reminder.attempt_count <= 0) {
    return true;
  }

  const backoffMinutes = Math.min(60, 2 ** Math.min(reminder.attempt_count, 5));
  const nextAttemptAt = new Date(reminder.last_attempt_at).getTime() + backoffMinutes * 60_000;

  return nextAttemptAt <= now.getTime();
}

function normalizeChannels(channels: ReminderChannel[] = ["in_app"]) {
  const normalized = channels.filter((channel): channel is ReminderChannel => channel === "in_app" || channel === "email");

  return [...new Set(normalized.length > 0 ? normalized : ["in_app"])];
}



function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function throwOnSupabaseError(result: { error: unknown }) {
  if (!result.error) {
    return;
  }

  const error = result.error instanceof Error ? result.error : new Error(String(result.error));
  throw error;
}

function isTaskReminderSchemaMiss(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const { code, message } = error as { code?: string; message?: string };
  const normalized = String(message ?? "").toLowerCase();
  return (
    (code === "PGRST204" || code === "PGRST205" || normalized.includes("schema cache") || normalized.includes("does not exist")) &&
    normalized.includes("motorist_task_reminders")
  );
}

function isNotificationSchemaMiss(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const { code, message } = error as { code?: string; message?: string };
  const normalized = String(message ?? "").toLowerCase();
  return (
    (code === "PGRST204" || code === "PGRST205" || normalized.includes("schema cache") || normalized.includes("does not exist")) &&
    normalized.includes("motorist_notifications")
  );
}

function isDuplicateError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}
