import type { TowingBillingStatus, TowingFields, TowingLine, TowingOrder, TowingPaymentStatus, TowingServiceType, TowingWorkStatus } from "@/domain/towing/types";
import { parseEuroCents } from "@/domain/towing/money";
import { towingDriverFieldNames } from "@/domain/towing/validation";

export const workLabels: Record<TowingWorkStatus, string> = { draft: "Nepridelené", assigned: "Pridelené", in_progress: "Prebieha", submitted: "Na kontrolu", needs_changes: "Na doplnenie", cancelled: "Stornované" };
export const billingLabels: Record<TowingBillingStatus, string> = { not_ready: "Nenacenené", ready: "Pripravené na fakturáciu", invoiced: "Fakturované", not_required: "Bez fakturácie" };
export const paymentLabels: Record<TowingPaymentStatus, string> = { unpriced: "Cena nepotvrdená", unpaid: "Neuhradené", partial: "Čiastočne uhradené", paid: "Uhradené", overpaid: "Preplatok" };
export const serviceLabels: Record<TowingServiceType, string> = { tow: "Odťah", repair: "Oprava na mieste", transport: "Preprava", storage: "Uloženie", relocation: "Preťah" };
export const blankFields: TowingFields = { serviceType: "tow", subjectType: "vehicle", subjectDescription: "", pickup: "" };
export function euro(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "—";
  return `${(cents / 100).toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
export function parseCents(value: string): number | null {
  try { return parseEuroCents(value.trim()); } catch { return null; }
}
export function inputMoney(cents: number | null | undefined) { return cents == null ? "" : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`; }
export function dateTime(value?: string) { return value ? new Date(value).toLocaleString("sk-SK", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "Neurčené"; }
export function localDateInput(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function isoDateInput(value: string) { return value ? new Date(value).toISOString() : undefined; }
export function workTone(status: TowingWorkStatus) { return status === "draft" || status === "needs_changes" ? "amber" : status === "cancelled" ? "red" : status === "submitted" ? "green" : "blue"; }
export function orderTitle(order: TowingOrder) { return [order.fields.plate, order.fields.subjectDescription].filter(Boolean).join(" · ") || serviceLabels[order.fields.serviceType]; }
export function navigationUrl(place: string) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`; }

const derivedFields = new Set(["startSource", "parkingName", "parkingAddress", "assistancePartnerName"]);
function fieldValue(value: unknown) {
  return JSON.stringify(value, (_key, item) => item === null ? undefined : item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Omit unchanged timestamps and server-derived provenance from operational edits. */
export function towingFieldsPatch(fields: Partial<TowingFields>, previous: TowingFields, driver = true): Record<string, unknown> {
  const names = driver ? towingDriverFieldNames : Object.keys(fields).filter(key => !derivedFields.has(key)) as (keyof TowingFields)[];
  return Object.fromEntries(names.filter(key => fieldValue(fields[key]) !== fieldValue(previous[key])).map(key => [key, fields[key] ?? null]));
}

export function towingPriceLinesKey(lines: readonly TowingLine[]) {
  return JSON.stringify(lines.map(({ id, description, quantity, unit, unitPrice, taxRate }) => ({ id, description, quantity, unit, unitPrice, taxRate })));
}
