import { addLocalDays, localMidnightToIso } from "@/lib/reporting";
import { isUuid } from "./uuid";

export type HistoryCursor = { startedAt: string | null; id: string };
export type CallHistoryCategory = "all" | "outbound" | "received" | "missed";
export type CallHistoryQuery = {
  q: string; from: string | null; to: string | null;
  category: CallHistoryCategory;
  direction: "inbound" | "outbound" | "internal" | null;
  outcome: string | null; operatorId: string | null; lineId: string | null;
  cursor: HistoryCursor | null; limit: number;
};
export class HistoryQueryError extends Error {}

/** Preserve PostgreSQL microseconds while rejecting loose Date.parse inputs. */
export function isHistoryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${value.slice(0,10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value.slice(0,10);
}

function day(value: string | null, end: boolean): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new HistoryQueryError("Zadajte platný dátum.");
  }
  return localMidnightToIso(end ? addLocalDays(value, 1) : value);
}
export function encodeHistoryCursor(cursor: HistoryCursor): string {
  // URI-safe JSON works in Node and the browser without a Buffer dependency.
  return encodeURIComponent(JSON.stringify(cursor));
}
export function decodeHistoryCursor(value: string | null): HistoryCursor | null {
  if (!value) return null;
  try {
    if (value.length > 300) throw new Error();
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!isUuid(parsed.id) || !(parsed.startedAt === null || isHistoryTimestamp(parsed.startedAt))) throw new Error();
    return { id: parsed.id, startedAt: parsed.startedAt };
  } catch { throw new HistoryQueryError("Neplatná stránka histórie."); }
}
export function parseCallHistoryQuery(params: URLSearchParams): CallHistoryQuery {
  const q = (params.get("q") ?? "").trim();
  if (q.length > 160) throw new HistoryQueryError("Hľadaný výraz je príliš dlhý.");
  const category = params.get("category") || "all";
  if (!["all", "outbound", "received", "missed"].includes(category)) throw new HistoryQueryError("Neplatná kategória hovoru.");
  const direction = params.get("direction") || null;
  if (direction && !["inbound", "outbound", "internal"].includes(direction)) throw new HistoryQueryError("Neplatný smer hovoru.");
  const outcome = params.get("outcome") || null;
  if (outcome && !/^[a-z_]{1,40}$/.test(outcome)) throw new HistoryQueryError("Neplatný výsledok hovoru.");
  const uuid = (key: string) => { const value = params.get(key) || null; if (value && !isUuid(value)) throw new HistoryQueryError("Neplatný filter."); return value; };
  const from = day(params.get("from"), false), to = day(params.get("to"), true);
  if (from && to && from >= to) throw new HistoryQueryError("Začiatok obdobia musí byť pred koncom.");
  const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HistoryQueryError("Neplatná veľkosť stránky.");
  return { q, from, to, category: category as CallHistoryCategory, direction: direction as CallHistoryQuery["direction"], outcome,
    operatorId: uuid("operatorId"), lineId: uuid("lineId"), cursor: decodeHistoryCursor(params.get("cursor")), limit };
}
