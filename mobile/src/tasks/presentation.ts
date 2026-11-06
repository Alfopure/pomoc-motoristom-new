import type { EmployeeTask } from "../../../src/lib/mobile-task-workspace";

export const taskStateLabels: Record<EmployeeTask["state"], string> = {
  todo: "Na vybavenie", in_progress: "Rozpracované", in_review: "Na kontrolu", done: "Hotovo",
};
export const taskPriorityLabels: Record<EmployeeTask["priority"], string> = {
  urgent: "Súrna", high: "Vysoká", normal: "Bežná", low: "Nízka",
};
export function taskDayKey(date: Date, timeZone?: string): string {
  if (!timeZone) return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}
export function taskDueLabel(value: string | null, now = new Date(), timeZone?: string): string {
  if (!value) return "Bez termínu";
  const date = new Date(value), today = taskDayKey(now, timeZone), key = taskDayKey(date, timeZone);
  const tomorrow = new Date(today + "T12:00:00Z"); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const options = timeZone ? { timeZone } : {};
  const day = key === today ? "Dnes" : key === tomorrow.toISOString().slice(0, 10) ? "Zajtra" : date.toLocaleDateString("sk-SK", { ...options, day: "numeric", month: "short", ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  return day + " · " + date.toLocaleTimeString("sk-SK", { ...options, hour: "2-digit", minute: "2-digit" });
}
export function taskOverdue(task: Pick<EmployeeTask, "state" | "dueAt">, now = Date.now()) {
  return task.state !== "done" && task.dueAt !== null && Date.parse(task.dueAt) < now;
}
export function taskRecipientLabel(task: Pick<EmployeeTask, "assignee" | "group">) {
  if (task.assignee) return [task.assignee.displayName, task.group?.name].filter(Boolean).join(" · ");
  return task.group ? task.group.name + " · Čaká na pridelenie" : "Bez riešiteľa";
}
type DueParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function dueParts(date: Date, timeZone?: string): DueParts {
  if (!timeZone) return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (key: string) => Number(parts.find(part => part.type === key)!.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}
/** The editor shows wall-clock values in exactly the zone used by list filters. */
export function dueDateInput(date: Date, timeZone?: string): { date: string; time: string } {
  const parts = dueParts(date, timeZone);
  return { date: `${parts.day}. ${parts.month}. ${parts.year}`, time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}` };
}
function dueWallEpoch(parts: DueParts) {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return value.getTime();
}
/** As in the existing towing form, derive offsets through Intl rather than
 * assuming Bratislava is always UTC+1. Probe both sides of a DST transition,
 * validate every candidate, and choose the earlier instant in an overlap. */
function zonedDueDate(parts: DueParts, timeZone: string): string {
  const wall = dueWallEpoch(parts), calendar = new Date(wall);
  if (parts.year < 1 || calendar.getUTCFullYear() !== parts.year || calendar.getUTCMonth() + 1 !== parts.month || calendar.getUTCDate() !== parts.day
    || calendar.getUTCHours() !== parts.hour || calendar.getUTCMinutes() !== parts.minute) throw new Error("Tento dátum alebo čas neexistuje. Skontrolujte ho.");
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = wall + hours * 3_600_000;
    offsets.add(dueWallEpoch(dueParts(new Date(probe), timeZone)) - probe);
  }
  const matches = [...offsets].map(offset => wall - offset).filter(instant => {
    const candidate = dueParts(new Date(instant), timeZone);
    return (Object.keys(parts) as (keyof DueParts)[]).every(key => candidate[key] === parts[key]);
  });
  if (!matches.length) throw new Error("Tento dátum alebo čas v časovom pásme organizácie neexistuje. Skontrolujte ho.");
  return new Date(Math.min(...matches)).toISOString();
}
export function duePreset(days: number, now = new Date(), timeZone?: string): string {
  if (!timeZone) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59).toISOString();
  const current = dueParts(now, timeZone);
  // Calendar arithmetic at UTC noon avoids adding 24h across 23/25-hour days.
  const calendar = new Date(0); calendar.setUTCFullYear(current.year, current.month - 1, current.day + days); calendar.setUTCHours(12, 0, 0, 0);
  return zonedDueDate({ year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(), hour: 23, minute: 59, second: 0 }, timeZone);
}
/** Human wall-clock date/time. Optional zone preserves legacy device-local
 * callers; organization callers reject nonexistent DST times instead of shifting. */
export function customDueDate(date: string, time: string, timeZone?: string): string {
  const day = /^\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})\s*$/.exec(date);
  const clock = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time);
  if (!day || !clock) throw new Error("Dátum zadajte napríklad 18. 11. 2026 a čas 17:00.");
  const [, d, m, y] = day.map(Number), [, h, min] = clock.map(Number);
  if (timeZone) return zonedDueDate({ year: y, month: m, day: d, hour: h, minute: min, second: 0 }, timeZone);
  const value = new Date(y, m - 1, d, h, min);
  if (value.getFullYear() !== y || value.getMonth() !== m - 1 || value.getDate() !== d || value.getHours() !== h || value.getMinutes() !== min) {
    throw new Error("Tento dátum alebo čas neexistuje. Skontrolujte ho.");
  }
  return value.toISOString();
}


export const taskWeekdays = ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok", "Sobota", "Nedeľa"];
export function taskRecurrenceIssue(recurrence: EmployeeTask["recurrence"]): string | null {
  if (recurrence?.state !== "needs_attention") return null;
  const reason = recurrence.issue === "creator_inactive" ? "Autor série už nemá potrebný prístup."
    : recurrence.issue === "recipient_unavailable" ? "Príjemca série už nie je dostupný."
      : "Autor alebo príjemca série už nemá potrebný prístup.";
  return reason + " Vytvorte novú opakovanú úlohu pod aktívnym účtom a s aktívnym príjemcom. Táto história zostane zachovaná.";
}
