import type { DispatchCase } from "@/domain/types";
import type { DispatchData } from "./dispatch-types";

// Task workspace data has its own revisions and must survive a card refresh.
export type CaseDetailData = Omit<DispatchCase, "tasks">;

/** PostgreSQL revisions include microseconds; Date.parse alone loses CAS ordering. */
export function compareCaseRevisions(left: string, right: string): number {
  const millis = Date.parse(left) - Date.parse(right);
  if (millis) return millis;
  const micros = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
  return micros(left) - micros(right);
}

export function mergeCaseDetail(current: DispatchData, detail: CaseDetailData): DispatchData {
  return { ...current, dispatchCases: current.dispatchCases.map(item => item.id === detail.id && compareCaseRevisions(detail.updatedAt, item.updatedAt) >= 0
    ? { ...item, ...detail, tasks: item.tasks } : item) };
}
