"use client";
import { Download, Loader2 } from "lucide-react";
import type { DispatchCase, CasePriority } from "@/domain/types";
import type { UpdateCaseInput } from "@/data/case-inputs";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import styles from "./case-detail.module.css";
export type CaseEditorControls = {
  priority: CasePriority;
  status: DispatchCase["status"];
  busy: boolean;
  onPriorityChange: (priority: CasePriority) => void;
  onStatusChange: (status: NonNullable<UpdateCaseInput["status"]>) => void;
};
export type CasePdfControls = {
  disabled: boolean;
  exporting: boolean;
  onDownload: () => Promise<void>;
};
export type CaseHeaderControls = CaseEditorControls & { pdf: CasePdfControls };
const editableStatuses = ["open", "waiting_for_docs", "completed_assisted", "completed_no_assistance", "cancelled", "futile_trip"] as const;
export function CaseEditorHeader({ controls }: { controls: CaseHeaderControls }) {
  return <div className={styles.headerControls} role="group" aria-label="Stav a priorita prípadu">
    <label>Stav prípadu
      <select aria-label="Stav prípadu v hlavičke" value={controls.status} disabled={controls.busy} onChange={event => controls.onStatusChange(event.target.value as NonNullable<UpdateCaseInput["status"]>)}>
        {!editableStatuses.some(status => status === controls.status) && <option value={controls.status}>{caseStatusLabels[controls.status]}</option>}
        {editableStatuses.map(status => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
      </select>
    </label>
    <label>Priorita
      <select aria-label="Priorita prípadu v hlavičke" value={controls.priority} disabled={controls.busy} onChange={event => controls.onPriorityChange(event.target.value as CasePriority)}>
        {Object.entries(casePriorityLabels).map(([priority, label]) => <option key={priority} value={priority}>{label}</option>)}
      </select>
    </label>
    <CasePdfButton controls={controls.pdf} />
  </div>;
}

export function CasePdfButton({ controls }: { controls: CasePdfControls }) {
  return <button
    type="button"
    aria-label="Stiahnuť PDF"
    aria-busy={controls.exporting}
    disabled={controls.disabled}
    onClick={() => void controls.onDownload()}
    className={`${styles.headerAction} ${styles.pdfAction} inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50`}
  >
    {controls.exporting ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
    {controls.exporting ? "Pripravujem PDF…" : "Stiahnuť PDF"}
  </button>;
}
