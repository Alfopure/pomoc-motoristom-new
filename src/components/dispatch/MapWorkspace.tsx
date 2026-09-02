"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripHorizontal } from "lucide-react";
import type { CallCenterCall, CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCall, DispatchCase, FleetAsset, Operator, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import type { DispatchMapModel } from "@/lib/map-adapter";
import type { WorkplaceWebphoneSessionFence } from "@/lib/telephony/webphone-client";
import { CaseCockpitPanel } from "./CaseCockpitPanel";
import { CaseTable, type CaseSortState } from "./CaseTable";
import { DispatchMap } from "./DispatchMap";
import { ExpandedCasePanel } from "./ExpandedCasePanel";
import type { SaveCaseDraft } from "./NewCaseDrawer";

export type WorkspaceKind = "cockpit" | "detail" | "new";
export type WorkspaceMode = "collapsed" | "split" | "expanded";
export type CenterView = "map" | "table";

type MapWorkspaceProps = {
  activeCaseId: string;
  assets: FleetAsset[];
  branches: Branch[];
  call: DispatchCall;
  caseItem?: DispatchCase;
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
  workplaceFence?: WorkplaceWebphoneSessionFence;
  onAssignAsset: (assetId: string) => void;
  onBackToCockpit: () => void;
  onCaseCreated: (dispatchData: DispatchData, caseId: string, notice?: string) => void;
  onCollapse: () => void;
  onDataChange: (dispatchData: DispatchData) => void;
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

const mobileSheetHeights: Record<WorkspaceMode, string> = {
  collapsed: "h-16",
  split: "h-[var(--dispatch-mobile-panel-height)]",
  expanded: "h-[calc(100dvh-76px-env(safe-area-inset-bottom))]",
};

const DEFAULT_DESKTOP_PANEL_PERCENT = 34;
const DEFAULT_MOBILE_PANEL_VH = 50;
const MIN_DESKTOP_PANEL_PERCENT = 20;
const MAX_DESKTOP_PANEL_PERCENT = 82;
const COLLAPSE_DESKTOP_PANEL_PERCENT = 24;
const EXPAND_DESKTOP_PANEL_PERCENT = 78;
const MIN_MOBILE_PANEL_VH = 34;
const MAX_MOBILE_PANEL_VH = 88;
const COLLAPSE_MOBILE_PANEL_VH = 36;
const EXPAND_MOBILE_PANEL_VH = 84;
const MOBILE_BOTTOM_NAV_OFFSET = 68;
const WORKSPACE_SHELL_ID = "dispatch-workspace-shell";

type StoredWorkspaceLayout = {
  desktopPanelPercent?: number;
  mobilePanelVh?: number;
};

export function MapWorkspace({
  activeCaseId,
  assets,
  branches,
  call,
  caseItem,
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
  workplaceFence,
}: MapWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutStorageKey = useMemo(() => `motorist:dispatch-workspace-layout:v2:${viewerProfileId ?? "local-browser"}`, [viewerProfileId]);
  const desktopPanelPercentRef = useRef(DEFAULT_DESKTOP_PANEL_PERCENT);
  const mobilePanelVhRef = useRef(DEFAULT_MOBILE_PANEL_VH);
  const pendingAnimationFrameRef = useRef<number | null>(null);
  const pendingDesktopPanelPercentRef = useRef(DEFAULT_DESKTOP_PANEL_PERCENT);
  const pendingMobilePanelVhRef = useRef(DEFAULT_MOBILE_PANEL_VH);
  const lastRawDesktopPanelPercentRef = useRef(DEFAULT_DESKTOP_PANEL_PERCENT);
  const lastRawMobilePanelVhRef = useRef(DEFAULT_MOBILE_PANEL_VH);
  const lastResizeSurfaceRef = useRef<"desktop" | "mobile">("desktop");
  const [desktopPanelPercent, setDesktopPanelPercent] = useState(DEFAULT_DESKTOP_PANEL_PERCENT);
  const [mobilePanelVh, setMobilePanelVh] = useState(DEFAULT_MOBILE_PANEL_VH);
  const hasCockpitCase = Boolean(caseItem && mapModel);
  const showWorkspacePanel = workspaceKind !== "cockpit" || hasCockpitCase;
  const showExpandedPanel = workspaceMode === "expanded" && workspaceKind !== "cockpit";
  const expandedOverlay = workspaceMode === "expanded";
  const upperAreaClassName =
    !showWorkspacePanel
      ? "h-full min-h-[440px] overflow-hidden lg:min-h-0"
      : workspaceMode === "expanded"
      ? "h-full min-h-[440px] overflow-hidden lg:min-h-0"
      : workspaceMode === "split"
        ? "min-h-[340px] overflow-hidden"
        : "h-full min-h-[440px] overflow-hidden lg:min-h-0";
  const shellClassName = !showWorkspacePanel
    ? "relative h-full min-h-0"
    : expandedOverlay
    ? "relative lg:h-full lg:min-h-0"
    : workspaceMode === "collapsed"
      ? "dispatch-workspace-shell relative lg:h-full lg:min-h-0"
      : `dispatch-workspace-shell lg:grid lg:h-full lg:min-h-0 lg:gap-2 ${desktopRows[workspaceMode]}`;
  const panelClassName = expandedOverlay
    ? "dispatch-workspace-panel fixed inset-x-0 top-[var(--dispatch-fixed-top,53px)] bottom-[calc(68px+env(safe-area-inset-bottom))] z-[2147482500] px-2 sm:bottom-[calc(72px+env(safe-area-inset-bottom))] lg:absolute lg:inset-0 lg:z-20 lg:h-full lg:px-0"
    : workspaceMode === "collapsed"
      ? `dispatch-workspace-panel fixed inset-x-0 bottom-[calc(68px+env(safe-area-inset-bottom))] z-[2147482500] h-16 px-2 sm:bottom-[calc(72px+env(safe-area-inset-bottom))] lg:absolute lg:inset-x-0 lg:bottom-0 lg:z-20 lg:h-16 lg:px-0`
      : `dispatch-workspace-panel fixed inset-x-0 bottom-[calc(68px+env(safe-area-inset-bottom))] z-[2147482500] px-2 sm:bottom-[calc(72px+env(safe-area-inset-bottom))] lg:relative lg:inset-auto lg:z-auto lg:h-full lg:px-0 ${mobileSheetHeights[workspaceMode]}`;
  const canResizeCockpit = workspaceKind === "cockpit" && hasCockpitCase;
  const sectionClassName =
    !showWorkspacePanel
      ? "relative min-h-[480px] bg-zinc-50 p-2 pb-[calc(76px+env(safe-area-inset-bottom))] sm:p-3 lg:h-full lg:min-h-0 lg:overflow-hidden lg:pb-3"
      : workspaceMode === "collapsed"
      ? "relative min-h-[420px] bg-zinc-50 p-2 pb-[calc(76px+env(safe-area-inset-bottom))] sm:p-3 lg:h-full lg:min-h-0 lg:overflow-hidden lg:pb-3"
      : "relative min-h-[560px] bg-zinc-50 p-2 pb-[calc(152px+env(safe-area-inset-bottom))] sm:p-3 lg:h-full lg:min-h-0 lg:overflow-hidden lg:pb-3";
  const resizeHandleClassName =
    workspaceMode === "expanded"
      ? "absolute left-1/2 top-3 z-[2147482600] flex h-7 w-20 -translate-x-1/2 touch-none cursor-ns-resize items-center justify-center rounded-full border border-zinc-300 bg-white/95 text-zinc-500 shadow-md backdrop-blur hover:border-zinc-400 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#FCD703] focus:ring-offset-2"
      : "absolute left-1/2 top-0 z-[2147482600] flex h-7 w-20 -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize items-center justify-center rounded-full border border-zinc-300 bg-white/95 text-zinc-500 shadow-md backdrop-blur hover:border-zinc-400 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#FCD703] focus:ring-offset-2";

  useEffect(() => {
    let nextDesktopPercent = DEFAULT_DESKTOP_PANEL_PERCENT;
    let nextMobileVh = DEFAULT_MOBILE_PANEL_VH;

    try {
      const raw = window.localStorage.getItem(layoutStorageKey);
      const parsed = raw ? (JSON.parse(raw) as StoredWorkspaceLayout) : undefined;

      if (typeof parsed?.desktopPanelPercent === "number") {
        nextDesktopPercent = clamp(Math.round(parsed.desktopPanelPercent), MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
      }

      if (typeof parsed?.mobilePanelVh === "number") {
        nextMobileVh = clamp(Math.round(parsed.mobilePanelVh), MIN_MOBILE_PANEL_VH, MAX_MOBILE_PANEL_VH);
      }
    } catch {
      // localStorage can be unavailable in private modes; defaults still work.
    }

    desktopPanelPercentRef.current = nextDesktopPercent;
    mobilePanelVhRef.current = nextMobileVh;
    pendingDesktopPanelPercentRef.current = nextDesktopPercent;
    pendingMobilePanelVhRef.current = nextMobileVh;
    const shell = containerRef.current;
    if (shell) {
      shell.style.setProperty("--dispatch-desktop-grid-rows", toDesktopGridRows(nextDesktopPercent));
      shell.style.setProperty("--dispatch-mobile-panel-height", `${Math.round(nextMobileVh)}dvh`);
    }

    return () => {
      if (pendingAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAnimationFrameRef.current);
        pendingAnimationFrameRef.current = null;
      }
    };
  }, [layoutStorageKey]);

  function updateDesktopPanelPercent(nextPercent: number, commitState = true) {
    desktopPanelPercentRef.current = nextPercent;
    if (commitState) {
      setDesktopPanelPercent(nextPercent);
    }
    scheduleLayoutVariables(nextPercent, mobilePanelVhRef.current);
  }

  function updateMobilePanelVh(nextVh: number, commitState = true) {
    mobilePanelVhRef.current = nextVh;
    if (commitState) {
      setMobilePanelVh(nextVh);
    }
    scheduleLayoutVariables(desktopPanelPercentRef.current, nextVh);
  }

  function scheduleLayoutVariables(nextDesktopPercent: number, nextMobileVh: number) {
    pendingDesktopPanelPercentRef.current = nextDesktopPercent;
    pendingMobilePanelVhRef.current = nextMobileVh;

    if (pendingAnimationFrameRef.current !== null) {
      return;
    }

    pendingAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pendingAnimationFrameRef.current = null;
      applyLayoutVariables(pendingDesktopPanelPercentRef.current, pendingMobilePanelVhRef.current);
    });
  }

  function commitLayoutState() {
    if (pendingAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingAnimationFrameRef.current);
      pendingAnimationFrameRef.current = null;
    }

    applyLayoutVariables(desktopPanelPercentRef.current, mobilePanelVhRef.current);
    setDesktopPanelPercent(desktopPanelPercentRef.current);
    setMobilePanelVh(mobilePanelVhRef.current);
  }

  function applyLayoutVariables(nextDesktopPercent: number, nextMobileVh: number) {
    const shell = containerRef.current;
    if (!shell) {
      return;
    }

    shell.style.setProperty("--dispatch-desktop-grid-rows", toDesktopGridRows(nextDesktopPercent));
    shell.style.setProperty("--dispatch-mobile-panel-height", `${Math.round(nextMobileVh)}dvh`);
  }

  function persistLayout(nextDesktopPercent = desktopPanelPercentRef.current, nextMobileVh = mobilePanelVhRef.current) {
    try {
      window.localStorage.setItem(
        layoutStorageKey,
        JSON.stringify({
          desktopPanelPercent: Math.round(nextDesktopPercent),
          mobilePanelVh: Math.round(nextMobileVh),
        } satisfies StoredWorkspaceLayout),
      );
    } catch {
      // localStorage can be unavailable in private modes; resizing must still work.
    }
  }

  function resizeFromClientY(clientY: number) {
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;

    if (isDesktop) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect?.height) {
        return;
      }

      const rawPercent = ((rect.bottom - clientY) / rect.height) * 100;
      const nextPercent = clamp(rawPercent, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
      lastResizeSurfaceRef.current = "desktop";
      lastRawDesktopPanelPercentRef.current = rawPercent;
      updateDesktopPanelPercent(nextPercent, false);
      return;
    }

    const rawVh = ((window.innerHeight - clientY - MOBILE_BOTTOM_NAV_OFFSET) / window.innerHeight) * 100;
    const nextVh = clamp(rawVh, MIN_MOBILE_PANEL_VH, MAX_MOBILE_PANEL_VH);
    lastResizeSurfaceRef.current = "mobile";
    lastRawMobilePanelVhRef.current = rawVh;
    updateMobilePanelVh(nextVh, false);
  }

  function handleResizePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!canResizeCockpit) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    containerRef.current?.setAttribute("data-resizing", "true");

    if (workspaceMode === "collapsed") {
      onRestore();
    }

    resizeFromClientY(event.clientY);
  }

  function handleResizePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    resizeFromClientY(event.clientY);
  }

  function handleResizePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    containerRef.current?.removeAttribute("data-resizing");
    commitLayoutState();

    const surface = lastResizeSurfaceRef.current;
    const shouldCollapse =
      surface === "desktop"
        ? lastRawDesktopPanelPercentRef.current <= COLLAPSE_DESKTOP_PANEL_PERCENT
        : lastRawMobilePanelVhRef.current <= COLLAPSE_MOBILE_PANEL_VH;
    const shouldExpand =
      surface === "desktop"
        ? lastRawDesktopPanelPercentRef.current >= EXPAND_DESKTOP_PANEL_PERCENT
        : lastRawMobilePanelVhRef.current >= EXPAND_MOBILE_PANEL_VH;

    if (shouldCollapse) {
      persistLayout(MIN_DESKTOP_PANEL_PERCENT, MIN_MOBILE_PANEL_VH);
      onCollapse();
      return;
    }

    if (shouldExpand) {
      persistLayout(MAX_DESKTOP_PANEL_PERCENT, MAX_MOBILE_PANEL_VH);
      onExpand();
      return;
    }

    persistLayout();
    if (workspaceMode === "expanded") {
      onRestore();
    }
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!canResizeCockpit) {
      return;
    }

    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    const step = event.shiftKey ? 8 : 4;
    let nextDesktopPercent = desktopPanelPercent;
    let nextMobileVh = mobilePanelVh;

    if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      if (workspaceMode === "collapsed") onRestore();
      nextDesktopPercent = clamp(desktopPanelPercent + step, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
      nextMobileVh = clamp(mobilePanelVh + step, MIN_MOBILE_PANEL_VH, MAX_MOBILE_PANEL_VH);
    } else if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      if (workspaceMode === "collapsed") onRestore();
      nextDesktopPercent = clamp(desktopPanelPercent - step, MIN_DESKTOP_PANEL_PERCENT, MAX_DESKTOP_PANEL_PERCENT);
      nextMobileVh = clamp(mobilePanelVh - step, MIN_MOBILE_PANEL_VH, MAX_MOBILE_PANEL_VH);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistLayout(MIN_DESKTOP_PANEL_PERCENT, MIN_MOBILE_PANEL_VH);
      onCollapse();
      return;
    } else if (event.key === "End") {
      event.preventDefault();
      persistLayout(MAX_DESKTOP_PANEL_PERCENT, MAX_MOBILE_PANEL_VH);
      onExpand();
      return;
    } else {
      return;
    }

    if (isDesktop) {
      updateDesktopPanelPercent(nextDesktopPercent);
      if (nextDesktopPercent <= COLLAPSE_DESKTOP_PANEL_PERCENT) {
        persistLayout(MIN_DESKTOP_PANEL_PERCENT, MIN_MOBILE_PANEL_VH);
        onCollapse();
        return;
      }
      if (nextDesktopPercent >= EXPAND_DESKTOP_PANEL_PERCENT) {
        persistLayout(MAX_DESKTOP_PANEL_PERCENT, MAX_MOBILE_PANEL_VH);
        onExpand();
        return;
      }
    } else {
      updateMobilePanelVh(nextMobileVh);
      if (nextMobileVh <= COLLAPSE_MOBILE_PANEL_VH) {
        persistLayout(MIN_DESKTOP_PANEL_PERCENT, MIN_MOBILE_PANEL_VH);
        onCollapse();
        return;
      }
      if (nextMobileVh >= EXPAND_MOBILE_PANEL_VH) {
        persistLayout(MAX_DESKTOP_PANEL_PERCENT, MAX_MOBILE_PANEL_VH);
        onExpand();
        return;
      }
    }
    persistLayout(nextDesktopPercent, nextMobileVh);
    if (workspaceMode === "expanded") {
      onRestore();
    }
  }

  return (
    <section className={sectionClassName}>
      <div id={WORKSPACE_SHELL_ID} ref={containerRef} className={shellClassName} data-workspace-mode={workspaceMode} suppressHydrationWarning>
        <div className={upperAreaClassName}>
          {centerView === "map" ? (
            <DispatchMap
              caseItem={caseItem}
              branches={branches}
              assets={assets}
              priceRule={priceRule}
              avoidMobileNav={workspaceMode !== "expanded"}
              workspaceMode={workspaceMode}
              onAssignAsset={onAssignAsset}
              onSendEtaSms={onSendEtaSms}
              onSendLocationSms={onSendLocationSms}
            />
          ) : centerView === "table" ? (
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
          ) : (
            <EmptyActiveCase />
          )}
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
              title="Potiahni hore alebo dole pre zmenu výšky"
            >
              <GripHorizontal size={18} aria-hidden="true" />
            </button>
          )}
          {showExpandedPanel ? (
            <ExpandedCasePanel
              key={`${workspaceKind}:${caseItem?.id ?? "empty"}`}
              assets={assets}
              branches={branches}
              call={call}
              caseItem={caseItem}
              commanderVehicles={commanderVehicles}
              focusedTaskId={focusedTaskId}
              kind={workspaceKind}
              onBackToCockpit={onBackToCockpit}
              onCaseCreated={onCaseCreated}
              onDataChange={onDataChange}
              onDirtyChange={onDirtyChange}
              onSaveDraftChange={onSaveDraftChange}
              onSavingChange={onSavingChange}
              operators={operators}
              partnerDirectory={partnerDirectory}
              priceRule={priceRule}
              viewerProfileId={viewerProfileId}
              workplaceFence={workplaceFence}
            />
          ) : caseItem && mapModel ? (
            <CaseCockpitPanel
              assets={assets}
              branches={branches}
              caseItem={caseItem}
              commanderVehicles={commanderVehicles}
              focusedTaskId={focusedTaskId}
              mode={workspaceMode}
              model={mapModel}
              onCollapse={onCollapse}
              onDataChange={onDataChange}
              onDirtyChange={onDirtyChange}
              onExpand={onExpand}
              onRestore={onRestore}
              onSaveDraftChange={onSaveDraftChange}
              onSavingChange={onSavingChange}
              operators={operators}
              partnerDirectory={partnerDirectory}
              priceRule={priceRule}
              viewerProfileId={viewerProfileId}
              workplaceFence={workplaceFence}
            />
          ) : (
            <EmptyActiveCase compact />
          )}
          </div>
        )}
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
