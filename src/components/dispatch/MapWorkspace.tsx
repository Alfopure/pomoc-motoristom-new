"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GripHorizontal, PanelLeftClose, Wrench } from "lucide-react";
import type { CallCenterCall, CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCall, DispatchCase, FleetAsset, Operator, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import type { DispatchMapModel } from "@/lib/map-adapter";
import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";
import { CaseCockpitPanel } from "./CaseCockpitPanel";
import { CaseTable, type CaseSortState } from "./CaseTable";
import { DispatchMap } from "./DispatchMap";
import { ExpandedCasePanel } from "./ExpandedCasePanel";
import type { SaveCaseDraft } from "./NewCaseDrawer";

export type WorkspaceKind = "cockpit" | "detail" | "new";
export type WorkspaceMode = "collapsed" | "split" | "expanded";
export type CenterView = "map" | "table" | "tasks" | "notes";

type MapWorkspaceProps = {
  active?: boolean;
  actorKey?: string;
  centerContent?: ReactNode;
  onCenterViewChange?: (view: CenterView) => void;
  onOpenTools?: () => void;
  onToggleLeft?: () => void;
  activeCaseId: string;
  assets: FleetAsset[];
  branches: Branch[];
  call: DispatchCall;
  caseItem?: DispatchCase;
  callLinkCandidates: PhoneBarCall[];
  commanderVehicles: CommanderVehicleConnection[];
  cases: DispatchCase[];
  centerView: CenterView;
  focusedTaskId?: string;
  mapModel?: DispatchMapModel;
  operators: Operator[];
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule?: PriceRule;
  sort: CaseSortState;
  totalCases: number;
  visibleCalls: CallCenterCall[];
  viewerProfileId?: string;
  workspaceKind: WorkspaceKind;
  workspaceMode: WorkspaceMode;
  onAssignAsset: (assetId: string) => void;
  onBackToCockpit: () => void;
  onCaseCreated: (dispatchData: DispatchData, caseId: string, notice?: string) => void;
  onCollapse: () => void;
  onDataChange: (dispatchData: DispatchData) => void;
  /** Click-to-call from the case card; absent while telephony is not configured. */
  onDial?: (phone: string, caseId?: string) => Promise<void>;
  onLinkCall: (call: PhoneBarCall, caseId: string) => Promise<boolean>;
  caseEditorRevision?: number;
  onDirtyChange: (dirty: boolean) => void;
  onSaveDraftChange: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange: (saving: boolean) => void;
  onExpand: () => void;
  onOpenDetail: (caseId: string) => void;
  onRestore: () => void;
  onSendEtaSms: () => void;
  onSendLocationSms: () => void;
  onSortChange: (sort: CaseSortState) => void;
};

const desktopRows: Record<WorkspaceMode, string> = {
  collapsed: "",
  split: "",
  expanded: "lg:grid-rows-[minmax(0,1fr)]",
};

const DEFAULT_DESKTOP_PANEL_PERCENT = 34;
const MIN_DESKTOP_PANEL_PERCENT = 20;
const MAX_DESKTOP_PANEL_PERCENT = 82;
const COLLAPSE_DESKTOP_PANEL_PERCENT = 24;
const EXPAND_DESKTOP_PANEL_PERCENT = 78;
const WORKSPACE_SHELL_ID = "dispatch-workspace-shell";

type StoredWorkspaceLayout = { desktopPanelPercent?: number };

export function MapWorkspace({
  active = true,
  actorKey,
  centerContent,
  onCenterViewChange,
  onOpenTools,
  onToggleLeft,
  activeCaseId,
  assets,
  branches,
  call,
  caseItem,
  callLinkCandidates,
  commanderVehicles,
  cases,
  centerView,
  focusedTaskId,
  mapModel,
  onAssignAsset,
  onBackToCockpit,
  onCaseCreated,
  onCollapse,
  onDataChange,
  onDial,
  onLinkCall,
  caseEditorRevision = 0,
  onDirtyChange,
  onSaveDraftChange,
  onSavingChange,
  onExpand,
  onOpenDetail,
  onRestore,
  onSendEtaSms,
  onSendLocationSms,
  onSortChange,
  operators,
  partnerDirectory,
  priceRule,
  sort,
  totalCases,
  visibleCalls,
  viewerProfileId,
  workspaceKind,
  workspaceMode,
}: MapWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutStorageKey = useMemo(() => `motorist:dispatch-workspace-layout:v3:${actorKey ?? viewerProfileId ?? "local-browser"}`, [actorKey, viewerProfileId]);
  const desktopPanelPercentRef = useRef(DEFAULT_DESKTOP_PANEL_PERCENT);
  const pendingAnimationFrameRef = useRef<number | null>(null);
  const lastRawDesktopPanelPercentRef = useRef(DEFAULT_DESKTOP_PANEL_PERCENT);
  const [desktopPanelPercent, setDesktopPanelPercent] = useState(DEFAULT_DESKTOP_PANEL_PERCENT);
  const hasCockpitCase = Boolean(caseItem && mapModel);
  const showWorkspacePanel = workspaceKind !== "cockpit" || hasCockpitCase;
  const showExpandedPanel = workspaceKind !== "cockpit";
  const shellClassName = `dispatch-workspace-shell relative h-full min-h-0 ${showWorkspacePanel && workspaceMode === "split" ? `lg:grid lg:gap-2 ${desktopRows[workspaceMode]}` : ""}`;
  const upperAreaClassName = `dispatch-workspace-upper h-full min-h-0 overflow-hidden ${showWorkspacePanel && workspaceMode === "split" ? "lg:h-auto lg:min-h-[340px]" : ""}`;
  // Mobile CSS displays either the full map or the full case, never a partial sheet.
  const panelClassName = workspaceMode === "expanded"
    ? "dispatch-workspace-panel absolute inset-0 z-[2147482500] lg:z-20 lg:h-full"
    : workspaceMode === "collapsed"
      ? "dispatch-workspace-panel hidden lg:absolute lg:inset-x-0 lg:bottom-0 lg:z-20 lg:block lg:h-16"
      : "dispatch-workspace-panel hidden lg:relative lg:block lg:h-full";
  const canResizeCockpit = workspaceKind === "cockpit" && hasCockpitCase;
  const sectionClassName = "dispatch-map-workspace relative flex flex-col h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-zinc-50 p-1 lg:p-3";
  const resizeHandleClassName = `absolute left-1/2 z-[2147482600] hidden h-7 w-20 -translate-x-1/2 touch-none cursor-ns-resize items-center justify-center rounded-full border border-zinc-300 bg-white/95 text-zinc-500 shadow-md backdrop-blur hover:border-zinc-400 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#FCD703] focus:ring-offset-2 lg:flex ${workspaceMode === "expanded" ? "top-3" : "top-0 -translate-y-1/2"}`;

  useEffect(() => {
    let nextPercent = DEFAULT_DESKTOP_PANEL_PERCENT;
    try {
      const raw = window.localStorage.getItem(layoutStorageKey);
      const parsed = raw ? JSON.parse(raw) as StoredWorkspaceLayout : undefined;
      if (typeof parsed?.desktopPanelPercent === "number" && Number.isFinite(parsed.desktopPanelPercent)) {
        nextPercent = clamp(Math.round(parsed.desktopPanelPercent), MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
      }
    } catch {
      // Defaults remain available when local storage is blocked.
    }
    desktopPanelPercentRef.current = nextPercent;
    containerRef.current?.style.setProperty("--dispatch-desktop-grid-rows", toDesktopGridRows(nextPercent));
    return () => {
      if (pendingAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAnimationFrameRef.current);
        pendingAnimationFrameRef.current = null;
      }
    };
  }, [layoutStorageKey]);

  function applyLayout() {
    containerRef.current?.style.setProperty("--dispatch-desktop-grid-rows", toDesktopGridRows(desktopPanelPercentRef.current));
  }

  function updateDesktopPanelPercent(nextPercent: number) {
    desktopPanelPercentRef.current = nextPercent;
    if (pendingAnimationFrameRef.current !== null) return;
    pendingAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pendingAnimationFrameRef.current = null;
      applyLayout();
    });
  }

  function commitLayoutState() {
    if (pendingAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingAnimationFrameRef.current);
      pendingAnimationFrameRef.current = null;
    }
    applyLayout();
    setDesktopPanelPercent(desktopPanelPercentRef.current);
  }

  function persistLayout(nextPercent = desktopPanelPercentRef.current) {
    try {
      window.localStorage.setItem(layoutStorageKey, JSON.stringify({ desktopPanelPercent: Math.round(nextPercent) } satisfies StoredWorkspaceLayout));
    } catch {
      // Desktop resizing also works without persistence.
    }
  }

  function resizeFromClientY(clientY: number) {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect?.height) return;
    const rawPercent = ((rect.bottom - clientY) / rect.height) * 100;
    lastRawDesktopPanelPercentRef.current = rawPercent;
    updateDesktopPanelPercent(clamp(rawPercent, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT));
  }

  function handleResizePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!canResizeCockpit || !window.matchMedia("(min-width: 1024px)").matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    containerRef.current?.setAttribute("data-resizing", "true");
    if (workspaceMode === "collapsed") onRestore();
    resizeFromClientY(event.clientY);
  }

  function handleResizePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeFromClientY(event.clientY);
  }

  function handleResizePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    containerRef.current?.removeAttribute("data-resizing");
    commitLayoutState();
    if (lastRawDesktopPanelPercentRef.current <= COLLAPSE_DESKTOP_PANEL_PERCENT) {
      persistLayout(MIN_DESKTOP_PANEL_PERCENT);
      onCollapse();
    } else if (lastRawDesktopPanelPercentRef.current >= EXPAND_DESKTOP_PANEL_PERCENT) {
      persistLayout(MAX_DESKTOP_PANEL_PERCENT);
      onExpand();
    } else {
      persistLayout();
      if (workspaceMode === "expanded") onRestore();
    }
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!canResizeCockpit || !window.matchMedia("(min-width: 1024px)").matches) return;
    const step = event.shiftKey ? 8 : 4;
    let nextPercent = desktopPanelPercentRef.current;
    if (event.key === "ArrowUp" || event.key === "PageUp") nextPercent += step;
    else if (event.key === "ArrowDown" || event.key === "PageDown") nextPercent -= step;
    else if (event.key === "Home") nextPercent = MIN_DESKTOP_PANEL_PERCENT;
    else if (event.key === "End") nextPercent = MAX_DESKTOP_PANEL_PERCENT;
    else return;
    event.preventDefault();
    nextPercent = clamp(nextPercent, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
    updateDesktopPanelPercent(nextPercent);
    commitLayoutState();
    persistLayout(nextPercent);
    if (nextPercent <= COLLAPSE_DESKTOP_PANEL_PERCENT) onCollapse();
    else if (nextPercent >= EXPAND_DESKTOP_PANEL_PERCENT) onExpand();
    else if (workspaceMode !== "split") onRestore();
  }

  return (
    <section className={sectionClassName}>
      {onCenterViewChange && <div className="workspace-center-tabs mb-1 flex min-h-11 items-center gap-1 overflow-x-auto" aria-label="Pracovná plocha">
        <button type="button" className="hidden min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-zinc-200 lg:flex" aria-label="Zbaliť panel prípadov" onClick={onToggleLeft}><PanelLeftClose size={18} /></button>
        {(["map", "tasks", "notes", "table"] as const).map(view => <button key={view} type="button" aria-pressed={centerView === view} onClick={() => onCenterViewChange(view)} className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ${centerView === view ? "bg-zinc-950 text-white" : "bg-white text-zinc-600 hover:bg-zinc-200"}`}>{({ map: "Mapa", tasks: "Úlohy", notes: "Poznámky", table: "Tabuľka" })[view]}</button>)}
        <button type="button" className="ml-auto flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-sm hover:bg-zinc-200" onClick={onOpenTools}><Wrench size={17} /><span>Nástroje</span></button>
      </div>}
      <div className="relative min-h-0 flex-1">
      <div id={WORKSPACE_SHELL_ID} ref={containerRef} className={shellClassName} data-workspace-mode={workspaceMode} suppressHydrationWarning>
        <div className={upperAreaClassName}>
          <div hidden={centerView !== "map"} inert={centerView !== "map"} className="dispatch-workspace-view h-full">
            <DispatchMap
              active={active && centerView === "map" && workspaceMode !== "expanded"}
              caseItem={caseItem}
              branches={branches}
              assets={assets}
              priceRule={priceRule}
              workspaceMode={workspaceMode}
              onAssignAsset={onAssignAsset}
              onSendEtaSms={onSendEtaSms}
              onSendLocationSms={onSendLocationSms}
            />
          </div>
          {centerView === "table" && (
            <CaseTable
              activeCaseId={activeCaseId}
              assets={assets}
              branches={branches}
              calls={visibleCalls}
              cases={cases}
              onOpenDetails={onOpenDetail}
              onSortChange={onSortChange}
              operators={operators}
              sort={sort}
              storageKey={`motorist:dispatch-case-table:visible-columns:v1:${viewerProfileId ?? "local-browser"}`}
              totalCases={totalCases}
              workspaceMode={workspaceMode}
            />
          )}
          <div hidden={centerView !== "tasks" && centerView !== "notes"} inert={centerView !== "tasks" && centerView !== "notes"} className="dispatch-workspace-view h-full">{centerContent}</div>
        </div>

        {showWorkspacePanel && (
          <div className={panelClassName} data-workspace-mode={workspaceMode}>
          {canResizeCockpit && (
            <button
              type="button"
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerEnd}
              onPointerCancel={handleResizePointerEnd}
              onKeyDown={handleResizeKeyDown}
              className={resizeHandleClassName}
              aria-label="Potiahnuť a zmeniť výšku spodnej lišty"
              aria-valuemax={MAX_DESKTOP_PANEL_PERCENT}
              aria-valuemin={MIN_DESKTOP_PANEL_PERCENT}
              aria-valuenow={Math.round(desktopPanelPercent)}
              role="separator"
              aria-orientation="horizontal"
              title="Potiahni hore alebo dole pre zmenu výšky"
            >
              <GripHorizontal size={18} aria-hidden="true" />
            </button>
          )}
          {showExpandedPanel ? (
            <ExpandedCasePanel
              key={`${workspaceKind}:${caseItem?.id ?? "empty"}:${caseEditorRevision}`}
              assets={assets}
              branches={branches}
              call={call}
              caseItem={caseItem}
              callLinkCandidates={callLinkCandidates}
              commanderVehicles={commanderVehicles}
              focusedTaskId={focusedTaskId}
              kind={workspaceKind}
              onBackToCockpit={onBackToCockpit}
              onCaseCreated={onCaseCreated}
              onDataChange={onDataChange}
              onDial={onDial}
              onLinkCall={onLinkCall}
              onDirtyChange={onDirtyChange}
              onSaveDraftChange={onSaveDraftChange}
              onSavingChange={onSavingChange}
              operators={operators}
              partnerDirectory={partnerDirectory}
              priceRule={priceRule}
              viewerProfileId={viewerProfileId}
            />
          ) : caseItem && mapModel ? (
            <CaseCockpitPanel
              key={caseEditorRevision}
              assets={assets}
              branches={branches}
              caseItem={caseItem}
              callLinkCandidates={callLinkCandidates}
              commanderVehicles={commanderVehicles}
              focusedTaskId={focusedTaskId}
              mode={workspaceMode}
              model={mapModel}
              onCollapse={onCollapse}
              onDataChange={onDataChange}
              onDial={onDial}
              onLinkCall={onLinkCall}
              onDirtyChange={onDirtyChange}
              onExpand={onExpand}
              onRestore={onRestore}
              onSaveDraftChange={onSaveDraftChange}
              onSavingChange={onSavingChange}
              operators={operators}
              partnerDirectory={partnerDirectory}
              priceRule={priceRule}
              viewerProfileId={viewerProfileId}
            />
          ) : (
            <EmptyActiveCase compact />
          )}
          </div>
        )}
      </div>
      </div>
    </section>
  );
}

function EmptyActiveCase({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`grid h-full min-h-0 place-items-center rounded-md border border-dashed border-zinc-300 bg-white p-6 text-center ${compact ? "min-h-16" : "min-h-[320px]"}`}>
      <div>
        <div className="text-sm font-semibold text-zinc-900">Žiadne aktívne prípady</div>
        {!compact && <p className="mt-1 text-xs font-medium text-zinc-500">Dokončené prípady nájdete v samostatnej histórii.</p>}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toDesktopGridRows(panelPercent: number) {
  const nextPanelPercent = Math.round(clamp(panelPercent, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT));
  return `minmax(260px, ${100 - nextPanelPercent}fr) minmax(96px, ${nextPanelPercent}fr)`;
}
