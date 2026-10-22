import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDue } from "@/domain/notifications";
import type { Database } from "@/lib/supabase/database.types";
import { callbackDeadline, CALLBACK_OVERDUE_MINUTES } from "@/lib/telephony/callback-queue";
import { isUuid } from "@/lib/telephony/uuid";
import { claimedEvents, claimPushes, deliverPushNotices, mobilePushEnabled, pruneMobilePush, pushRecipients, queueMobilePush, releaseClaims, sendMobilePush, type PushClaim, type PushDevice, type PushNotice, type PushTransport } from "./push";
import { canOperateTelephony } from "@/lib/app-environment";
import { missingSchema } from "./field-auth";

/** The events that reach a dispatcher's phone. Each text names at most a case
 * number and a time; titles of tasks, names and phone numbers stay in the app. */
type Admin = SupabaseClient<Database>;
const READ_MS = 8_000;

async function caseNumberOf(admin: Admin, organizationId: string, caseId: string | null): Promise<string | null> {
  if (!caseId) return null;
  const row = await admin.from("motorist_cases").select("case_number").eq("organization_id", organizationId).eq("id", caseId).abortSignal(AbortSignal.timeout(READ_MS)).maybeSingle();
  return row.data?.case_number ?? null;
}
const forCase = (caseNumber: string | null) => caseNumber ? " k prípadu " + caseNumber : "";

/** A task assigned to someone else; sent once per assignment notification. */
export function pushTaskAssigned(admin: Admin, job: { organizationId: string; notificationId: string; taskId: string; recipientProfileId: string }) {
  queueMobilePush(async () => {
    const task = await admin.from("motorist_case_tasks").select("case_id,due_at,status,assigned_to,created_by,assignment_generation").eq("organization_id", job.organizationId).eq("id", job.taskId)
      .abortSignal(AbortSignal.timeout(READ_MS)).maybeSingle();
    // Reassigned or finished in the meantime: the old assignee is not disturbed.
    if (!task.data || task.data.status === "done" || task.data.assigned_to !== job.recipientProfileId) return;
    // Created for oneself (also by a case action or a call, delivered later by the cron): no news.
    if (task.data.assignment_generation === 0 && task.data.created_by === job.recipientProfileId) return;
    const caseNumber = await caseNumberOf(admin, job.organizationId, task.data.case_id);
    await sendMobilePush(admin, {
      organizationId: job.organizationId, profileIds: [job.recipientProfileId], type: "tasks", title: "Nová úloha",
      body: "Máte pridelenú úlohu" + forCase(caseNumber) + (task.data.due_at ? ", termín " + formatDue(task.data.due_at) : "") + ".",
      data: { kind: "task", id: job.taskId }, dedupeKey: "task-assigned:" + job.notificationId,
    });
  });
}

/** A reminder sent this long after the deadline says the deadline has passed. The
 * default reminder fires at the deadline and the cron runs every five minutes, so a
 * few minutes late is still "má termín". */
const LATE_REMINDER_MS = 60 * 60_000;

/** A saved due-date reminder of a task. */
export function pushTaskDue(admin: Admin, reminder: { organizationId: string; notificationId: string; taskId: string; recipientProfileId: string; caseNumber: string | null; dueAt: string | null; now: Date }) {
  const late = reminder.dueAt !== null && reminder.now.getTime() - Date.parse(reminder.dueAt) > LATE_REMINDER_MS;
  queueMobilePush(() => sendMobilePush(admin, {
    organizationId: reminder.organizationId, profileIds: [reminder.recipientProfileId], type: "task_due",
    title: !reminder.dueAt ? "Pripomienka úlohy" : late ? "Úloha po termíne" : "Termín úlohy",
    body: "Úloha" + forCase(reminder.caseNumber) + (reminder.dueAt ? (late ? " mala termín " : " má termín ") + formatDue(reminder.dueAt) + "." : " čaká na vybavenie."),
    data: { kind: "task", id: reminder.taskId }, dedupeKey: "task-due:" + reminder.notificationId,
  }));
}

/** Handing a task over for review, or returning it, notifies the person who now has to act. */
export function pushTaskReview(admin: Admin, change: { organizationId: string; taskId: string; action: string }) {
  if (change.action !== "submit_review" && change.action !== "return") return;
  if (!isUuid(change.taskId)) return;
  queueMobilePush(async () => {
    // The workflow transaction wrote the in-app notice and chose its recipient.
    const notice = await admin.from("motorist_notifications").select("id,recipient_profile_id,case_id").eq("organization_id", change.organizationId)
      .eq("task_id", change.taskId).eq("status", "unread").like("dedupe_key", "task-review:" + change.taskId + ":generation:%:" + change.action + ":recipient:%")
      .order("created_at", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(READ_MS)).maybeSingle();
    if (!notice.data?.recipient_profile_id) return;
    const caseNumber = await caseNumberOf(admin, change.organizationId, notice.data.case_id);
    await sendMobilePush(admin, {
      organizationId: change.organizationId, profileIds: [notice.data.recipient_profile_id], type: "tasks",
      title: change.action === "submit_review" ? "Úloha na kontrolu" : "Úloha vrátená na dopracovanie",
      body: change.action === "submit_review" ? "Kolega vám poslal úlohu" + forCase(caseNumber) + " na kontrolu." : "Kontrolór vám vrátil úlohu" + forCase(caseNumber) + ".",
      data: { kind: "task", id: change.taskId }, dedupeKey: "task-review:" + notice.data.id,
    });
  });
}

/** A colleague made someone else the dispatcher of a case. */
export function pushCaseAssigned(admin: Admin, change: { organizationId: string; caseId: string; ownerId: string; actorProfileId: string; committedRevision: string }) {
  if (change.ownerId === change.actorProfileId) return;
  queueMobilePush(async () => {
    const caseNumber = await caseNumberOf(admin, change.organizationId, change.caseId);
    await sendMobilePush(admin, {
      organizationId: change.organizationId, profileIds: [change.ownerId], type: "cases", title: "Pridelený prípad",
      body: caseNumber ? "Kolega vám pridelil prípad " + caseNumber + "." : "Kolega vám pridelil prípad.",
      data: { kind: "case", id: change.caseId }, dedupeKey: "case-owner:" + change.caseId + ":" + change.committedRevision,
    });
  });
}

/** Slovak counting for two and more: 2–4 take the plural, 5 and more the genitive. */
const few = (count: number) => count >= 2 && count <= 4;
export function callbackPushText(type: "callbacks_mine" | "callbacks_unclaimed", count: number): { title: string; body: string } {
  if (type === "callbacks_mine") {
    return count === 1
      ? { title: "Spätné volanie po termíne", body: "Vaše prevzaté spätné volanie čaká na zavolanie." }
      : { title: "Spätné volania po termíne", body: count + (few(count) ? " vaše prevzaté spätné volania čakajú" : " vašich prevzatých spätných volaní čaká") + " na zavolanie." };
  }
  return count === 1
    ? { title: "Spätné volanie bez dispečera", body: "Požiadavka na spätné volanie je po termíne a nikto ju neprevzal." }
    : { title: "Spätné volania bez dispečera", body: count + (few(count) ? " požiadavky na spätné volanie sú" : " požiadaviek na spätné volanie je") + " po termíne a nikto ich neprevzal." };
}

/** How far back a newly overdue callback is still announced, e.g. after an outage of
 * the push service; older ones are the queue's business, not a fresh alert. */
const CALLBACK_LOOKBACK_MS = 2 * 3_600_000;

/** Cron step: an open callback past its deadline alerts whoever took it, or every
 * dispatcher with the app when nobody did. One message per person and kind per
 * pass; each callback deadline is announced once (one archived row per callback),
 * and again on the next pass only if the push service reached nobody. */
export async function runMobileCallbackPush(admin: Admin, organizationId: string, now = new Date(), transport: PushTransport = fetch) {
  if (!mobilePushEnabled()) return { status: "disabled" as const, detail: { reason: "push_disabled" } };
  const since = now.getTime() - CALLBACK_LOOKBACK_MS, legacy = CALLBACK_OVERDUE_MINUTES * 60_000;
  const signal = AbortSignal.timeout(READ_MS);
  const live = () => admin.from("motorist_callback_requests").select("id,claimed_by,due_at,created_at")
    .eq("organization_id", organizationId).in("status", ["open", "scheduled"]).abortSignal(signal);
  const [withDue, withoutDue] = await Promise.all([
    live().not("due_at", "is", null).gt("due_at", new Date(since).toISOString()).lte("due_at", now.toISOString()).order("due_at", { ascending: false }).limit(50),
    live().is("due_at", null).gt("created_at", new Date(since - legacy).toISOString()).lte("created_at", new Date(now.getTime() - legacy).toISOString())
      .order("created_at", { ascending: false }).limit(50),
  ]);
  if (withDue.error || withoutDue.error) throw new Error("Overdue callbacks unavailable");
  const overdue = [...withDue.data ?? [], ...withoutDue.data ?? []].flatMap(row => {
    const deadline = callbackDeadline({ dueAt: row.due_at, createdAt: row.created_at });
    return deadline === null || deadline > now.getTime() ? [] : [{ id: row.id, claimedBy: row.claimed_by, key: "callback-overdue:" + row.id + ":" + deadline }];
  });
  const detail = { overdue: overdue.length, announced: 0, sent: 0, failed: 0 };
  if (!overdue.length) return { status: "ok" as const, detail };
  // Most passes find only callbacks announced earlier: one read, nothing written.
  const known = await claimedEvents(admin, organizationId, overdue.map(item => item.key));
  const pending = overdue.filter(item => !known.has(item.key));
  if (!pending.length) return { status: "ok" as const, detail };

  const mine = pending.filter(item => item.claimedBy), unclaimed = pending.filter(item => !item.claimedBy);
  const none = new Map<string, PushDevice[]>();
  const [owners, team] = await Promise.all([
    mine.length ? pushRecipients(admin, organizationId, "callbacks_mine", mine.map(item => item.claimedBy!), now) : none,
    unclaimed.length ? pushRecipients(admin, organizationId, "callbacks_unclaimed", "team", now) : none,
  ]);
  // Nobody to tell yet: the callback stays unannounced, so someone who switches on later still hears of it.
  const firstOfTeam = [...team.keys()][0];
  const claims: PushClaim[] = [
    ...mine.filter(item => owners.has(item.claimedBy!)).map(item => ({ profileId: item.claimedBy!, key: item.key, type: "callbacks_mine" as const, ...callbackPushText("callbacks_mine", 1) })),
    ...firstOfTeam ? unclaimed.map(item => ({ profileId: firstOfTeam, key: item.key, type: "callbacks_unclaimed" as const, ...callbackPushText("callbacks_unclaimed", 1) })) : [],
  ];
  const fresh = await claimPushes(admin, organizationId, claims, now);
  const announced = claims.filter(claim => fresh.has(claim.key));
  detail.announced = announced.length;
  const mineCount = new Map<string, number>();
  for (const claim of announced) if (claim.type === "callbacks_mine") mineCount.set(claim.profileId, (mineCount.get(claim.profileId) ?? 0) + 1);
  const teamCount = announced.filter(claim => claim.type === "callbacks_unclaimed").length;
  const notices: PushNotice[] = [];
  for (const [profileId, count] of mineCount) notices.push(...(owners.get(profileId) ?? []).map(device => ({ device, ...callbackPushText("callbacks_mine", count), data: { kind: "callbacks" as const } })));
  if (teamCount) for (const devices of team.values()) notices.push(...devices.map(device => ({ device, ...callbackPushText("callbacks_unclaimed", teamCount), data: { kind: "callbacks" as const } })));
  const outcomes = await deliverPushNotices(admin, notices, transport);
  detail.sent = outcomes.filter(outcome => outcome === "sent").length;
  detail.failed = outcomes.filter(outcome => outcome === "failed").length;
  // The push service reached nobody: the next pass tries the same callbacks again.
  if (detail.failed && !detail.sent) await releaseClaims(admin, organizationId, announced.map(claim => claim.key));
  if (detail.failed) console.warn(JSON.stringify({ event: "mobile.push", type: "callbacks", sent: detail.sent, failed: detail.failed }));
  return { status: "ok" as const, detail };
}

/** Cron step, once an hour: forgets silent phones, old announcements and delivery
 * positions older than 30 days. Positions go even while deliveries are switched
 * off, as the privacy policy promises; a database without them is fine. */
export async function runMobilePushUpkeep(admin: Admin, organizationId: string, now = new Date()) {
  if (now.getUTCMinutes() >= 5) return null;
  const pushed = mobilePushEnabled() ? await pruneMobilePush(admin, organizationId, now) : null;
  let positions = 0;
  if (canOperateTelephony()) {
    const pruned = await admin.rpc("motorist_handoff_positions_prune");
    if (pruned.error && !missingSchema(pruned.error.code)) throw new Error("position upkeep unavailable");
    positions = typeof pruned.data === "number" ? pruned.data : 0;
  }
  return { ...(pushed ?? { devices: 0, claims: 0 }), positions };
}
