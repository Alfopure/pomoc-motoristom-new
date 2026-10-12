import type { MobileCaseFilter } from "../../../src/lib/mobile-api";
import { isClosedCaseStatus } from "../../../src/lib/mobile-case-filters";

export type CaseSelection = Omit<MobileCaseFilter, "cursor">;
export type CaseShortcut = "open" | "mine" | "unassigned" | "urgent";
export function caseShortcut(value: CaseShortcut): CaseSelection {
  return { ownership: value === "mine" || value === "unassigned" ? value : "all", category: "open", ownerId: null, q: "", status: null, priority: value === "urgent" ? "urgent" : null };
}
export function caseRecoverySelection(): CaseSelection {
  return { ...caseShortcut("open"), category: "all" };
}
export function canReviewCaseCreation(selection: CaseSelection): boolean {
  return selection.ownership === "all" && selection.category === "all" && !selection.ownerId && !selection.q.trim() && selection.status == null && selection.priority == null;
}
export function statusForCategory(status: MobileCaseFilter["status"], category: MobileCaseFilter["category"]): MobileCaseFilter["status"] {
  return category === "open" && status && isClosedCaseStatus(status) ? null : status;
}
