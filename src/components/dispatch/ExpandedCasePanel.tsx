"use client";

import { ArrowLeft, FileText, Plus } from "lucide-react";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCall, DispatchCase, FleetAsset, Operator, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import { CaseDetail } from "./CaseDetail";
import { NewCaseForm, type SaveCaseDraft } from "./NewCaseDrawer";

type ExpandedCasePanelProps = {
  assets: FleetAsset[];
  branches: Branch[];
  call: DispatchCall;
  caseItem?: DispatchCase;
  commanderVehicles: CommanderVehicleConnection[];
  focusedTaskId?: string;
  kind: "detail" | "new";
  operators: Operator[];
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule?: PriceRule;
  onBackToCockpit: () => void;
  onCaseCreated: (dispatchData: DispatchData, caseId: string, notice?: string) => void;
  onDataChange?: (dispatchData: DispatchData) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftChange?: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange?: (saving: boolean) => void;
  viewerProfileId?: string;
};

export function ExpandedCasePanel({
  assets,
  branches,
  call,
  caseItem,
  commanderVehicles,
  focusedTaskId,
  kind,
  operators,
  onBackToCockpit,
  onCaseCreated,
  onDataChange,
  onDirtyChange,
  onSaveDraftChange,
  onSavingChange,
  partnerDirectory,
  priceRule,
  viewerProfileId,
}: ExpandedCasePanelProps) {
  const isNew = kind === "new";
  function handleDirtyChange(dirty: boolean) {
    onDirtyChange?.(dirty);
  }

  function handleSavingChange(saving: boolean) {
    onSavingChange?.(saving);
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
            {isNew ? <Plus size={16} /> : <FileText size={16} />}
            <span>{isNew ? "Nový prípad" : `Karta prípadu ${caseItem?.caseNumber ?? ""}`}</span>
          </div>
          <div className="mt-0.5 truncate text-xs font-medium text-zinc-500">
            {isNew ? "ID prípadu sa pridelí po uložení" : `${caseItem?.caseType || "Typ nezadaný"} · ${caseItem?.contact.name || "Kontakt nezadaný"}`}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onBackToCockpit}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[#FCD703] px-3 text-xs font-semibold text-zinc-950 hover:bg-yellow-300"
          >
            <ArrowLeft size={15} />
            Späť
          </button>
        </div>
      </div>

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
          <div className="h-full overflow-auto p-3 sm:p-4" data-case-detail-scroll-region>
            <CaseDetail
              key={caseItem.id}
              caseItem={caseItem}
              commanderVehicles={commanderVehicles}
              branches={branches}
              assets={assets}
              focusedTaskId={focusedTaskId}
              editing
              embedded
              onDataChange={onDataChange}
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
