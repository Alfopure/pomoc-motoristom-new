import type { CaseStatus } from "@/domain/types";

export const closedCaseStatuses = new Set<CaseStatus>(["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"]);
export type CaseStatusSelection = "all" | "active" | "closed" | "selected" | CaseStatus;
export function matchesCaseStatus(status: CaseStatus, selection: CaseStatusSelection, selected: readonly CaseStatus[] = []) {
  if (selection === "all") return true;
  if (selection === "active") return !closedCaseStatuses.has(status);
  if (selection === "closed") return closedCaseStatuses.has(status);
  if (selection === "selected") return selected.includes(status);
  return status === selection;
}
