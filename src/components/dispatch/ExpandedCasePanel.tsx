"use client";
import type { CaseDetailData } from "@/data/case-detail";

import { useState, type ReactNode } from "react";
import { ArrowLeft, FileText, Plus } from "lucide-react";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCall, DispatchCase, FleetAsset, Operator, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";
import { CaseDetail } from "./CaseDetail";
import { CaseEditorHeader, type CaseHeaderControls } from "./CaseEditorHeader";
import styles from "./case-detail.module.css";
import { NewCaseForm, type SaveCaseDraft } from "./NewCaseDrawer";

type ExpandedCasePanelProps = {
  renderTaskWorkflow?: (taskId: string) => ReactNode;
  assets: FleetAsset[];
  branches: Branch[];
  call: DispatchCall;
  caseItem?: DispatchCase;
  callLinkCandidates?: PhoneBarCall[];
  commanderVehicles: CommanderVehicleConnection[];
  focusedTaskId?: string;
  kind: "detail" | "new";
  operators: Operator[];
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule?: PriceRule;
  onBackToCockpit: () => void;
  onCaseCreated: (dispatchData: DispatchData, caseId: string, notice?: string) => void;
  onDataChange?: (dispatchData: DispatchData) => void;
  onCaseChange?: (caseDetail: CaseDetailData) => void;
  /** Click-to-call from the case card; absent while telephony is not configured. */
  onDial?: (phone: string, caseId?: string) => Promise<void>;
  onLinkCall?: (call: PhoneBarCall, caseId: string) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftChange?: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange?: (saving: boolean) => void;
  viewerProfileId?: string;
};

export function ExpandedCasePanel({
  renderTaskWorkflow,
  assets,
  branches,
  call,
  caseItem,
  callLinkCandidates,
  commanderVehicles,
  focusedTaskId,
  kind,
  operators,
  onBackToCockpit,
  onCaseCreated,
  onDataChange,
  onCaseChange,
  onDial,
  onLinkCall,
  onDirtyChange,
  onSaveDraftChange,
  onSavingChange,
  partnerDirectory,
  priceRule,
  viewerProfileId,
}: ExpandedCasePanelProps) {
  const isNew = kind === "new";
  const [editorControls, setEditorControls] = useState<CaseHeaderControls | null>(null);
  function handleDirtyChange(dirty: boolean) {
    onDirtyChange?.(dirty);
  }

  function handleSavingChange(saving: boolean) {
    onSavingChange?.(saving);
  }

  return (
    <section className={`${styles.surface} flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white lg:rounded-md lg:border lg:border-zinc-200 lg:shadow-sm`}>
      <div className="hidden shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 py-2 lg:flex">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
            {isNew ? <Plus size={16} /> : <FileText size={16} />}
            <span className="min-w-0 break-words">{isNew ? "Nový prípad" : `Karta prípadu ${caseItem?.caseNumber ?? ""}`}</span>
          </div>
          <div className="mt-0.5 truncate text-xs font-medium text-zinc-500">
            {isNew ? "ID prípadu sa pridelí po uložení" : `${caseItem?.caseType || "Typ nezadaný"} · ${caseItem?.contact.name || "Kontakt nezadaný"}`}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onBackToCockpit}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-[#FCD703] px-3 text-sm font-semibold text-zinc-950 hover:bg-yellow-300 lg:h-9 lg:text-xs"
          >
            <ArrowLeft size={15} />
            Späť
          </button>
        </div>
      </div>

      {!isNew && caseItem && editorControls && <div className={`${styles.headerControlRow} shrink-0`}><CaseEditorHeader controls={editorControls} /></div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isNew ? (
          <NewCaseForm
            key={`${call.id}:${call.callerNumber}:${call.startedAt}`}
            call={call}
            commanderVehicles={commanderVehicles}
            onClose={onBackToCockpit}
            onCreated={onCaseCreated}
            onDirtyChange={handleDirtyChange}
            onSaveDraftChange={onSaveDraftChange}
            onSavingChange={handleSavingChange}
            partnerDirectory={partnerDirectory}
          />
        ) : caseItem ? (
          <div className={`${styles.scrollRegion} h-full min-w-0 overflow-y-auto overscroll-contain`} data-case-detail-scroll-region>
            <CaseDetail
              renderTaskWorkflow={renderTaskWorkflow}
              onEditorControlsChange={setEditorControls}
              key={caseItem.id}
              caseItem={caseItem}
              callLinkCandidates={callLinkCandidates}
              commanderVehicles={commanderVehicles}
              branches={branches}
              assets={assets}
              focusedTaskId={focusedTaskId}
              editing
              embedded
              onDataChange={onDataChange}
            onCaseChange={onCaseChange}
              onDial={onDial}
              onLinkCall={onLinkCall}
              onDirtyChange={handleDirtyChange}
              onSaveDraftChange={onSaveDraftChange}
              onSavingChange={handleSavingChange}
              operators={operators}
              partnerDirectory={partnerDirectory}
              persistentEditing
              priceRule={priceRule}
              showInlineEditButton={false}
              viewerProfileId={viewerProfileId}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm font-medium text-zinc-500">
            Aktívny prípad nie je k dispozícii.
          </div>
        )}
      </div>
    </section>
  );
}
