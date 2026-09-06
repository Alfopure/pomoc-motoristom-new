export type NotificationTarget = { kind: "task"; id: string } | { kind: "call"; id: string } | { kind: "settings" };

export const CALL_NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Notification URLs are navigation hints, never commands or arbitrary URLs. */
export function notificationTarget(value: unknown, origin: string): NotificationTarget | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/" || url.username || url.password) return null;
    const tasks = url.searchParams.getAll("task");
    const calls = url.searchParams.getAll("call");
    if (tasks.length && calls.length) return null;
    if (calls.length) return calls.length === 1 && CALL_NOTIFICATION_ID.test(calls[0]) ? { kind: "call", id: calls[0].toLowerCase() } : null;
    if (tasks.length) return tasks.length === 1 && /^[a-zA-Z0-9_-]{1,100}$/.test(tasks[0]) ? { kind: "task", id: tasks[0] } : null;
    return { kind: "settings" };
  } catch {
    return null;
  }
}
