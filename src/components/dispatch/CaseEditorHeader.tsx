"use client";
import type { DispatchCase, CasePriority } from "@/domain/types";
import type { UpdateCaseInput } from "@/data/case-inputs";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
export type CaseEditorControls = {
  priority: CasePriority;
  status: DispatchCase["status"];
  busy: boolean;
  onPriorityChange: (priority: CasePriority) => void;
  onStatusChange: (status: NonNullable<UpdateCaseInput["status"]>) => void;
};
const editableStatuses = ["open", "waiting_for_docs", "completed_assisted", "completed_no_assistance", "cancelled", "futile_trip"] as const;
export function CaseEditorHeader({ controls }: { controls: CaseEditorControls }) {
  return <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Stav a priorita prípadu">
    <label className="grid min-w-0 gap-0.5 text-xs font-semibold text-zinc-600">Stav prípadu
      <select aria-label="Stav prípadu v hlavičke" value={controls.status} disabled={controls.busy} onChange={event => controls.onStatusChange(event.target.value as NonNullable<UpdateCaseInput["status"]>)} className="h-11 min-w-0 max-w-full rounded-md border border-zinc-300 bg-white px-2 text-base text-zinc-950">
        {!editableStatuses.some(status => status === controls.status) && <option value={controls.status}>{caseStatusLabels[controls.status]}</option>}
        {editableStatuses.map(status => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
      </select>
    </label>
    <label className="grid min-w-0 gap-0.5 text-xs font-semibold text-zinc-600">Priorita
      <select aria-label="Priorita prípadu v hlavičke" value={controls.priority} disabled={controls.busy} onChange={event => controls.onPriorityChange(event.target.value as CasePriority)} className="h-11 min-w-0 max-w-full rounded-md border border-zinc-300 bg-white px-2 text-base text-zinc-950">
        {Object.entries(casePriorityLabels).map(([priority, label]) => <option key={priority} value={priority}>{label}</option>)}
      </select>
    </label>
  </div>;
}
