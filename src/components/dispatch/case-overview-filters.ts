import type { DispatchCase } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import type { CaseFilters } from "./CaseList";

type OverviewFilters = Pick<CaseFilters, "branchId" | "jobType" | "createdFrom" | "createdTo">;
const calendarDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: MOTORIST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Additional directory filters; the shared status/owner/source rules stay in the console. */
export function matchesCaseOverviewFilters(
  item: Pick<DispatchCase, "branchId" | "jobTypes" | "createdAt">,
  filters: OverviewFilters,
) {
  if (filters.branchId && filters.branchId !== "all" && item.branchId !== filters.branchId) return false;
  if (filters.jobType && filters.jobType !== "all" && !item.jobTypes.includes(filters.jobType)) return false;
  if (!filters.createdFrom && !filters.createdTo) return true;
  const created = new Date(item.createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  const parts = calendarDate.formatToParts(created);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  return (!filters.createdFrom || day >= filters.createdFrom) && (!filters.createdTo || day <= filters.createdTo);
}

export function countCaseOverviewFilters(filters: OverviewFilters) {
  return [
    filters.branchId && filters.branchId !== "all",
    filters.jobType && filters.jobType !== "all",
    filters.createdFrom,
    filters.createdTo,
  ].filter(Boolean).length;
}
