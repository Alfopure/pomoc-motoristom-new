import type { CaseTask, CustomerSharedLocation, DispatchCase, DispatchNotification, TimelineEvent } from "@/domain/types";

/**
 * Payload of `GET /api/cases/location-updates`, the console's 10 s live poll.
 *
 * The case snapshot is otherwise only reloaded by this tab's own actions, so a
 * task a colleague created, reassigned, finished or reopened would sit
 * invisible until the next reload. The poll carries every task changed since
 * the cursor and this module folds it into the snapshot in place.
 */
export type LiveUpdatesResponse = {
  checkedAt?: string;
  error?: string;
  notifications?: DispatchNotification[];
  updates?: LiveLocationUpdate[];
  /** Tasks created or changed by anybody in the organisation since the cursor. */
  tasks?: CaseTask[];
};

export type LiveLocationUpdate = {
  caseId: string;
  event: TimelineEvent;
  location: CustomerSharedLocation;
};

type LiveUpdatable = { dispatchCases: DispatchCase[]; notifications: DispatchNotification[] };

export function hasLiveUpdates(result: LiveUpdatesResponse): boolean {
  return (result.updates?.length ?? 0) > 0 || (result.notifications?.length ?? 0) > 0 || (result.tasks?.length ?? 0) > 0;
}

export function mergeLiveUpdates<T extends LiveUpdatable>(current: T, result: LiveUpdatesResponse): T {
  const latestByCaseId = new Map<string, LiveLocationUpdate>();
  for (const update of result.updates ?? []) {
    const previous = latestByCaseId.get(update.caseId);
    if (!previous || dateValue(update.location.submittedAt) > dateValue(previous.location.submittedAt)) {
      latestByCaseId.set(update.caseId, update);
    }
  }

  const tasksByCaseId = new Map<string, CaseTask[]>();
  for (const task of result.tasks ?? []) {
    tasksByCaseId.set(task.caseId, [...(tasksByCaseId.get(task.caseId) ?? []), task]);
  }

  const dispatchCases = current.dispatchCases.map((caseItem) => {
    const update = latestByCaseId.get(caseItem.id);
    const locationChanged = Boolean(update && dateValue(caseItem.customerSharedLocation?.submittedAt) < dateValue(update.location.submittedAt));
    const incoming = tasksByCaseId.get(caseItem.id);
    const tasks = incoming ? mergeTasks(caseItem.tasks, incoming) : caseItem.tasks;
    if (!locationChanged && tasks === caseItem.tasks) {
      return caseItem;
    }

    return {
      ...caseItem,
      ...(locationChanged && update
        ? {
            customerSharedLocation: update.location,
            timeline: caseItem.timeline.some((event) => event.id === update.event.id) ? caseItem.timeline : [...caseItem.timeline, update.event],
          }
        : {}),
      tasks,
    };
  });
  const existingNotificationIds = new Set(current.notifications.map((notification) => notification.id));
  const newNotifications = (result.notifications ?? []).filter((notification) => !existingNotificationIds.has(notification.id));

  return {
    ...current,
    dispatchCases,
    notifications: newNotifications.length > 0 ? [...newNotifications, ...current.notifications] : current.notifications,
  };
}

/**
 * Folds polled tasks into a case. The same array comes back when nothing
 * changed, so an untouched case keeps its identity and does not re-render.
 * A poll that was answered before this tab's own action must not roll that
 * action back, hence the version comparison.
 */
function mergeTasks(tasks: CaseTask[], incoming: CaseTask[]): CaseTask[] {
  let next = tasks;
  for (const task of incoming) {
    const index = next.findIndex((existing) => existing.id === task.id);
    if (index < 0) {
      next = [...next, task];
      continue;
    }
    const existing = next[index];
    if (existing.updatedAt && task.updatedAt && dateValue(task.updatedAt) <= dateValue(existing.updatedAt)) {
      continue;
    }
    next = next.map((entry, position) => (position === index ? task : entry));
  }
  return next;
}

function dateValue(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}
