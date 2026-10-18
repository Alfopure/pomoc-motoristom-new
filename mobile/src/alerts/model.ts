import type { MobileCaseSummary, MobileTask } from "../../../src/lib/mobile-api";
import type { MobileCallbackRequest } from "../../../src/lib/mobile-callbacks";
import { callbackUrgency, deadlineText } from "../callbacks/model";
import { formatNumber } from "../lib/display";

/** What needs a dispatcher now, derived from data the app already reads:
 * callback promises at or past their deadline, own tasks due today or late,
 * and burning cases. Nothing is stored; every refresh recomputes the list. */
export type AlertKind = "callback" | "task" | "case";
export type AlertItem = {
  key: string; kind: AlertKind; id: string; title: string; detail: string;
  tag: string; tone: "red" | "orange"; rank: number;
};
const ZONE = "Europe/Bratislava";

export function dayKey(time: number): string {
  return new Date(time).toLocaleDateString("en-CA", { timeZone: ZONE });
}
function clock(time: number): string {
  return new Date(time).toLocaleTimeString("sk-SK", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
}

export function callbackAlerts(open: readonly MobileCallbackRequest[], now: number): AlertItem[] {
  return open.flatMap(item => {
    const urgency = callbackUrgency(item, now);
    if (urgency === "fresh") return [];
    const claimed = item.claimant ? item.claimant.mine ? "prevzali ste" : "prevzal " + (item.claimant.name ?? "kolega") : "nikto neprevzal";
    return [{ key: "callback:" + item.id, kind: "callback" as const, id: item.id, title: item.name || formatNumber(item.number),
      detail: ["Spätné volanie", item.lineLabel, claimed].filter(Boolean).join(" · "), tag: deadlineText(item, now) ?? "",
      tone: urgency === "overdue" ? "red" as const : "orange" as const, rank: urgency === "overdue" ? 0 : 3 }];
  });
}

export function taskAlerts(tasks: readonly MobileTask[], now: number): AlertItem[] {
  const today = dayKey(now);
  return tasks.flatMap(task => {
    if (!task.dueAt || task.status === "done") return [];
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due)) return [];
    const late = due < now;
    if (!late && dayKey(due) !== today) return [];
    return [{ key: "task:" + task.id, kind: "task" as const, id: task.id, title: task.title,
      detail: ["Úloha", task.assignedTo?.name ?? null].filter(Boolean).join(" · "),
      tag: late ? (dayKey(due) === today ? "Po termíne " + clock(due) : "Po termíne") : "Dnes " + clock(due),
      tone: late ? "red" as const : "orange" as const, rank: late ? 1 : 4 }];
  });
}

export function caseAlerts(cases: readonly MobileCaseSummary[]): AlertItem[] {
  return cases.filter(item => item.priority === "urgent").map(item => ({
    key: "case:" + item.id, kind: "case" as const, id: item.id,
    title: [item.contact.name || "Kontakt bez mena", item.vehicle.licensePlate].filter(Boolean).join(" · "),
    detail: [item.caseNumber, item.statusLabel, item.owner.mine ? "váš prípad" : item.owner.name].filter(Boolean).join(" · "),
    tag: item.owner.id ? item.priorityLabel : item.priorityLabel + " · bez dispečera", tone: "red" as const, rank: item.owner.id ? 5 : 2,
  }));
}

/** Most pressing first; equal ranks keep their source order. */
export function sortAlerts(items: readonly AlertItem[]): AlertItem[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => a.item.rank - b.item.rank || a.index - b.index).map(entry => entry.item);
}
