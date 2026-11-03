import { casePriorities, casePriorityLabels, caseStatusLabels } from "../domain/statuses";
import type { CasePriority, CaseStatus } from "../domain/types";

/** Shared web vocabulary, kept free of server/native dependencies. */
export { caseStatusLabels, casePriorityLabels };
export const MOBILE_CASE_STATUSES = Object.keys(caseStatusLabels) as CaseStatus[];
export const MOBILE_CASE_PRIORITIES = casePriorities;
export const MOBILE_CLOSED_CASE_STATUSES = [
  "completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip",
] as const satisfies readonly CaseStatus[];

export function isMobileCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === "string" && Object.hasOwn(caseStatusLabels, value);
}
export function isMobileCasePriority(value: unknown): value is CasePriority {
  return typeof value === "string" && Object.hasOwn(casePriorityLabels, value);
}
export function isClosedCaseStatus(value: unknown): boolean {
  return MOBILE_CLOSED_CASE_STATUSES.some(status => status === value);
}
