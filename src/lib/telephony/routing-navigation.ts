import type { RoutingNavigationTarget } from "./routing-summary";
import { isUuid } from "./uuid";

const ids = ["lineId", "planId", "groupId", "ivrMenuId", "businessHoursId"] as const;
export function routingTargetFromUrl(url: URL): RoutingNavigationTarget | null {
  if (url.searchParams.get("view") !== "settings" || url.searchParams.get("section") !== "telephony") return null;
  const value = url.searchParams.get("routingTab");
  const tab = value && ["incoming", "numbers", "ivr", "hours"].includes(value) ? value as RoutingNavigationTarget["tab"] : "incoming";
  const target: RoutingNavigationTarget = { section: "telephony", tab };
  for (const key of ids) { const value = url.searchParams.get(key); if (isUuid(value)) target[key] = value; }
  return target;
}
export function routingTargetUrl(current: string, target: RoutingNavigationTarget): URL {
  const url = new URL(current);
  url.searchParams.set("view", "settings"); url.searchParams.set("section", "telephony"); url.searchParams.set("routingTab", target.tab);
  for (const key of ids) { if (target[key]) url.searchParams.set(key, target[key]); else url.searchParams.delete(key); }
  return url;
}
export function clearRoutingTargetUrl(current: string, view: string): URL {
  const url = new URL(current);
  for (const key of [...ids, "section", "routingTab"]) url.searchParams.delete(key);
  if (view === "call-center") url.searchParams.set("view", view); else url.searchParams.delete("view");
  return url;
}
