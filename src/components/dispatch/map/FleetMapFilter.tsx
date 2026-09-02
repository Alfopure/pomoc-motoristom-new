"use client";

import { RotateCcw, Search, X } from "lucide-react";
import type { FleetAssetKind, FleetAssetStatus } from "@/domain/types";
import { statusLabel, statusOptions } from "@/lib/fleet-presentation";

export type FleetKindFilter = "all" | FleetAssetKind;
export type FleetGpsSourceFilter = "all" | "webdispecink" | "commander" | "none";
export type FleetGpsFreshnessFilter = "all" | "live" | "stale" | "none";
export type FleetStatusFilter = "all" | FleetAssetStatus;

export function FleetMapFilter({
  activeCount,
  freshnessFilter,
  gpsSourceFilter,
  kindFilter,
  search,
  statusFilter,
  onClose,
  onFreshnessFilterChange,
  onGpsSourceFilterChange,
  onKindFilterChange,
  onReset,
  onSearchChange,
  onStatusFilterChange,
}: {
  activeCount: number;
  freshnessFilter: FleetGpsFreshnessFilter;
  gpsSourceFilter: FleetGpsSourceFilter;
  kindFilter: FleetKindFilter;
  search: string;
  statusFilter: FleetStatusFilter;
  onClose: () => void;
  onFreshnessFilterChange: (value: FleetGpsFreshnessFilter) => void;
  onGpsSourceFilterChange: (value: FleetGpsSourceFilter) => void;
  onKindFilterChange: (value: FleetKindFilter) => void;
  onReset: () => void;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: FleetStatusFilter) => void;
}) {
  return (
    <div className="pointer-events-auto w-full rounded-xl bg-white/95 p-2 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:w-[420px]">
      <div className="mb-1.5 flex items-center justify-between gap-2 pl-1">
        <span className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Filter flotily</span>
        <div className="flex items-center gap-1">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <RotateCcw size={12} />
              Zrušiť ({activeCount})
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Zavrieť filter flotily"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <label className="relative block min-w-0">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Hľadať vo flotile (ŠPZ, značka, názov)"
          className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
        />
      </label>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <select
          value={kindFilter}
          onChange={(event) => onKindFilterChange(event.target.value as FleetKindFilter)}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
        >
          <option value="all">Všetky typy</option>
          <option value="tow_truck">Odťahy</option>
          <option value="replacement_car">Náhradné</option>
        </select>
        <select
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as FleetStatusFilter)}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
        >
          <option value="all">Všetky stavy</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>
              {statusLabel[status]}
            </option>
          ))}
        </select>
        <select
          value={gpsSourceFilter}
          onChange={(event) => onGpsSourceFilterChange(event.target.value as FleetGpsSourceFilter)}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
        >
          <option value="all">Všetky GPS</option>
          <option value="webdispecink">WebDispečink</option>
          <option value="commander">Commander</option>
          <option value="none">Bez GPS</option>
        </select>
        <select
          value={freshnessFilter}
          onChange={(event) => onFreshnessFilterChange(event.target.value as FleetGpsFreshnessFilter)}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
        >
          <option value="all">Live/stale</option>
          <option value="live">Live</option>
          <option value="stale">Stale</option>
          <option value="none">Bez GPS</option>
        </select>
      </div>
    </div>
  );
}
