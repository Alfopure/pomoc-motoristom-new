import type { CallCenterCall } from "@/data/dispatch-types";

export const HISTORY_CATEGORIES = [
  { value: "all", label: "Všetky" },
  { value: "outbound", label: "Volané" },
  { value: "received", label: "Prijaté" },
  { value: "missed", label: "Zmeškané" },
] as const;
export type HistoryCategory = typeof HISTORY_CATEGORIES[number]["value"];
export const HISTORY_COLUMNS = [
  { key: "duration", label: "Dĺžka rozhovoru", heading: "Dĺžka", width: 48 },
  { key: "recording", label: "Nahrávka", heading: "Záznam", width: 42 },
  { key: "waiting", label: "Čakanie", heading: "Čakanie", width: 60 },
  { key: "callback", label: "Spätné volanie", heading: "Spätné volanie", width: 118 },
  { key: "note", label: "Poznámka", heading: "Poznámka", width: 170 },
] as const;
export type HistoryColumn = typeof HISTORY_COLUMNS[number]["key"];
export const DEFAULT_HISTORY_COLUMNS: HistoryColumn[] = ["duration", "recording"];
export function parseHistoryColumns(value: unknown): HistoryColumn[] {
  return Array.isArray(value) ? HISTORY_COLUMNS.filter(option => value.includes(option.key)).map(option => option.key) : DEFAULT_HISTORY_COLUMNS;
}
export function historySeconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function historyResult(call: CallCenterCall): { label: string; tone: "neutral" | "positive" | "negative" | "pending" } {
  if (call.endReason === "callback_requested") return { label: "Spätné volanie", tone: "pending" };
  if (call.answeredAt) return { label: call.direction === "inbound" ? "Prijatý" : "Spojený", tone: "positive" };
  if (call.status === "failed") return { label: "Neúspešný", tone: "negative" };
  if (call.status === "abandoned_queue") return { label: "Zložený v čakárni", tone: "negative" };
  if (call.status === "missed") return { label: call.direction === "outbound" ? "Nedovolané" : "Zmeškaný", tone: "negative" };
  if (call.status === "answered") return { label: "Prebieha", tone: "positive" };
  if (call.status === "ended" || call.endedAt) return { label: "Ukončený", tone: "neutral" };
  return { label: call.direction === "outbound" ? "Vytáča sa" : "Zvoní", tone: "pending" };
}
export function historyCallbackLabel(call: CallCenterCall): string {
  if (!call.callback) return "—";
  return { open: "Čaká", scheduled: call.callback.claimedByName ? "Prevzaté" : "Naplánované", done: "Vybavené", cancelled: "Zrušené" }[call.callback.status];
}
