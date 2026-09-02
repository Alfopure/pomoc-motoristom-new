"use client";

import type { LucideIcon } from "lucide-react";
import { Car, Eraser, MapPin, MapPinned, Maximize2, Minimize2, Navigation, Route, Search, SlidersHorizontal, Truck } from "lucide-react";

export type FleetLayerKey = "tow" | "replacement_car";

export type MapPanelKey = "search" | "addresses" | "filter";

export type MapLayerState = {
  route: boolean;
  branches: boolean;
  fleet: Record<FleetLayerKey, boolean>;
};

export function MapControlBar({
  activePanel,
  canClear,
  compactWorkspace,
  expandedWorkspace,
  filterCount,
  focusMode,
  layers,
  planOpen,
  showCaseTools,
  showFilter,
  onClearAll,
  onToggleBranches,
  onToggleFleet,
  onToggleFocus,
  onTogglePanel,
  onTogglePlan,
  onToggleRoute,
}: {
  activePanel: MapPanelKey | null;
  canClear: boolean;
  compactWorkspace: boolean;
  expandedWorkspace: boolean;
  filterCount: number;
  focusMode: boolean;
  layers: MapLayerState;
  planOpen: boolean;
  showCaseTools: boolean;
  showFilter: boolean;
  onClearAll: () => void;
  onToggleBranches: () => void;
  onToggleFleet: (layer: FleetLayerKey) => void;
  onToggleFocus: () => void;
  onTogglePanel: (panel: MapPanelKey) => void;
  onTogglePlan: () => void;
  onToggleRoute: () => void;
}) {
  return (
    <div
      aria-label="Ovládanie mapy"
      className="pointer-events-auto flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-xl bg-white/95 p-1 shadow-sm ring-1 ring-zinc-200 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="toolbar"
    >
      <IconToggle active={activePanel === "search"} icon={Search} label="Hľadať miesto" onClick={() => onTogglePanel("search")} />
      {!expandedWorkspace && showCaseTools && (
        <IconToggle active={activePanel === "addresses"} icon={MapPin} label="Adresy zásahu" onClick={() => onTogglePanel("addresses")} />
      )}

      {showCaseTools && <Divider />}

      {showCaseTools && <Chip active={layers.route} icon={Route} label="Trasa" onClick={onToggleRoute} />}
      <Chip active={layers.branches} icon={MapPinned} label="Pobočky" onClick={onToggleBranches} />
      <Chip active={layers.fleet.tow} icon={Truck} label="Odťahovky" onClick={() => onToggleFleet("tow")} />
      <Chip active={layers.fleet.replacement_car} icon={Car} label="Náhradné" onClick={() => onToggleFleet("replacement_car")} />
      {showFilter && (
        <Chip
          active={activePanel === "filter"}
          badge={filterCount}
          icon={SlidersHorizontal}
          label="Filter"
          onClick={() => onTogglePanel("filter")}
        />
      )}

      {!expandedWorkspace && showCaseTools && <Divider />}

      {!compactWorkspace && showCaseTools && <Chip active={planOpen} icon={Navigation} label="Plán" onClick={onTogglePlan} />}
      {!expandedWorkspace && (
        <IconToggle
          active={focusMode}
          icon={focusMode ? Minimize2 : Maximize2}
          label={focusMode ? "Späť z focusu" : "Focus mapa"}
          onClick={onToggleFocus}
        />
      )}

      <Divider />

      <button
        type="button"
        onClick={onClearAll}
        disabled={!canClear}
        title="Vyčistiť mapu"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-zinc-600 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
      >
        <Eraser size={14} className="shrink-0" />
        <span className="hidden sm:inline">Vyčistiť</span>
      </button>
    </div>
  );
}

function Chip({
  active,
  badge,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition ${
        active ? "bg-zinc-950 text-white shadow-sm" : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      <Icon size={14} className="shrink-0" />
      <span>{label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span
          className={`min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4 ${
            active ? "bg-[#FCD703] text-zinc-950" : "bg-zinc-950 text-white"
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function IconToggle({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
        active ? "bg-zinc-950 text-white shadow-sm" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
      }`}
    >
      <Icon size={15} />
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-zinc-200" aria-hidden="true" />;
}
