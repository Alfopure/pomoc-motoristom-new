"use client";

import { useMemo, useState } from "react";
import { Archive, ListChecks, Plus, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { CaseTable, type CaseSortState } from "./CaseTable";
import type { CaseFilters } from "./CaseList";
import type { CallCenterCall } from "@/data/dispatch-types";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import type { CasePriority, CaseStatus, DispatchCase, FleetAsset, Branch, Operator } from "@/domain/types";

type CaseDirectoryProps = {
  activeCaseId: string;
  activeFilterCount: number;
  assets: FleetAsset[];
  assistanceServices: string[];
  branches: Branch[];
  calls: CallCenterCall[];
  cases: DispatchCase[];
  filters: CaseFilters;
  operators: Operator[];
  search: string;
  sort: CaseSortState;
  totalCases: number;
  onClearFilters: () => void;
  onFiltersChange: (filters: CaseFilters) => void;
  onNewCase: () => void;
  onOpenDetails: (caseId: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (sort: CaseSortState) => void;
};

const statusOptions: CaseStatus[] = [
  "new",
  "triage",
  "open",
  "waiting_for_client",
  "scheduled",
  "assigned",
  "dispatched",
  "in_progress",
  "waiting_for_docs",
  "completed_assisted",
  "completed_no_assistance",
  "rejected",
  "cancelled",
  "futile_trip",
];
const priorityOptions: CasePriority[] = ["urgent", "high", "normal", "low"];
type CaseSourceType = NonNullable<DispatchCase["sourceType"]>;
const sourceOptions: CaseSourceType[] = ["client", "assistance", "samoplatca", "partner", "internal"];
const sourceLabels: Record<CaseSourceType, string> = {
  client: "Klient",
  assistance: "Asistenčka",
  samoplatca: "Samoplatca",
  partner: "Partner",
  internal: "Interné",
};

type DirectoryMode = "active" | "history";

const terminalStatuses = new Set<CaseStatus>([
  "completed_assisted",
  "completed_no_assistance",
  "rejected",
  "cancelled",
  "futile_trip",
]);

export function CaseDirectory({
  activeCaseId,
  activeFilterCount,
  assets,
  assistanceServices,
  branches,
  calls,
  cases,
  filters,
  onClearFilters,
  onFiltersChange,
  onNewCase,
  onOpenDetails,
  onSearchChange,
  onSortChange,
  operators,
  search,
  sort,
  totalCases,
}: CaseDirectoryProps) {
  const [mode, setMode] = useState<DirectoryMode>("active");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeCount = useMemo(() => cases.filter((caseItem) => !terminalStatuses.has(caseItem.status)).length, [cases]);
  const historyCount = cases.length - activeCount;
  const visibleCases = useMemo(
    () => cases.filter((caseItem) => (mode === "active" ? !terminalStatuses.has(caseItem.status) : terminalStatuses.has(caseItem.status))),
    [cases, mode],
  );

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-zinc-50 p-1.5 lg:p-3">
      <section className="mb-1.5 max-h-[70%] shrink-0 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 bg-white p-2 lg:mb-3 lg:max-h-none lg:overflow-visible lg:p-3 lg:shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 lg:gap-3">
          <div className="hidden min-w-0 lg:block">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-700">
              <SlidersHorizontal size={16} />
              {mode === "active" ? "Aktívne prípady" : "História prípadov"}
            </div>
            <p className="mt-1 text-xs font-medium text-zinc-500">
              {visibleCases.length} z {totalCases} záznamov
              {activeFilterCount > 0 ? ` · ${activeFilterCount} aktívne filtre` : ""}
            </p>
          </div>
          <div className="flex w-full items-center gap-1.5 lg:w-auto lg:flex-wrap lg:gap-2">
            <button
              type="button"
              onClick={onNewCase}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800 lg:gap-2 lg:px-3 lg:shadow-sm"
            >
              <Plus size={14} />
              Nový prípad
            </button>
            <button
              type="button"
              onClick={() => setFiltersOpen((current) => !current)}
              aria-expanded={filtersOpen}
              aria-controls="directory-filters"
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 lg:hidden"
            >
              <SlidersHorizontal size={16} />
              Filtre{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
            </button>
            <button
              type="button"
              onClick={onClearFilters}
              className={`${activeFilterCount > 0 ? "inline-flex" : "hidden"} h-9 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 lg:inline-flex lg:gap-2 lg:px-3`}
              disabled={activeFilterCount === 0}
            >
              <RotateCcw size={14} />
              Vyčistiť
            </button>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-0.5 lg:mt-3 lg:w-fit lg:min-w-[320px] lg:p-1">
          <button
            type="button"
            onClick={() => setMode("active")}
            aria-pressed={mode === "active"}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold ${mode === "active" ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:bg-white/70"}`}
          >
            <ListChecks size={14} />
            Aktívne ({activeCount})
          </button>
          <button
            type="button"
            onClick={() => setMode("history")}
            aria-pressed={mode === "history"}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold ${mode === "history" ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:bg-white/70"}`}
          >
            <Archive size={14} />
            História ({historyCount})
          </button>
        </div>

        <div className="mt-2 grid gap-2 md:grid-cols-2 lg:mt-3 xl:grid-cols-[minmax(260px,1.6fr)_repeat(5,minmax(140px,1fr))]">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-sm text-zinc-500 md:col-span-2 lg:px-3 lg:py-2 xl:col-span-1">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              aria-label="Hľadať prípady v adresári"
              className="min-w-0 flex-1 bg-transparent text-zinc-800 outline-none placeholder:text-zinc-400"
              placeholder="Prípad, telefón, EČV, mesto…"
            />
          </label>
          <div id="directory-filters" className={`${filtersOpen ? "grid" : "hidden"} min-w-0 grid-cols-2 gap-2 md:col-span-2 lg:contents`}>
          <FilterSelect
            label="Stav"
            value={filters.status}
            onChange={(value) => onFiltersChange({ ...filters, status: value as CaseFilters["status"] })}
            options={[["all", "Všetky stavy"], ...statusOptions.map((status) => [status, caseStatusLabels[status]] as const)]}
          />
          <FilterSelect
            label="Priorita"
            value={filters.priority}
            onChange={(value) => onFiltersChange({ ...filters, priority: value as CaseFilters["priority"] })}
            options={[["all", "Všetky priority"], ...priorityOptions.map((priority) => [priority, casePriorityLabels[priority]] as const)]}
          />
          <FilterSelect
            label="Operátor"
            value={filters.ownerId}
            onChange={(value) => onFiltersChange({ ...filters, ownerId: value })}
            options={[["all", "Všetci operátori"], ...operators.map((operator) => [operator.id, operator.name] as const)]}
          />
          <FilterSelect
            label="Zdroj"
            value={filters.sourceType}
            onChange={(value) => onFiltersChange({ ...filters, sourceType: value as CaseFilters["sourceType"] })}
            options={[["all", "Všetky zdroje"], ...sourceOptions.map((sourceType) => [sourceType, sourceLabels[sourceType]] as const)]}
          />
          <FilterSelect
            label="Asistenčná služba"
            value={filters.assistanceService}
            onChange={(value) => onFiltersChange({ ...filters, assistanceService: value })}
            options={[["all", "Všetky asistenčky"], ...assistanceServices.map((name) => [name, name] as const)]}
          />
          </div>
          <label className={`${filtersOpen ? "flex" : "hidden"} min-w-0 items-center gap-2 text-xs font-semibold text-zinc-600 md:col-span-2 lg:hidden`}>
            Poradie
            <select
              aria-label="Zoradiť adresár prípadov"
              value={["priority", "createdAt", "updatedAt"].includes(sort.key) ? sort.key : ""}
              onChange={(event) => onSortChange({ key: event.target.value as CaseSortState["key"], direction: event.target.value === "priority" ? "asc" : "desc" })}
              className="h-11 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-base text-zinc-900"
            >
              {!["priority", "createdAt", "updatedAt"].includes(sort.key) && <option value="" disabled>Vlastné poradie</option>}
              <option value="priority">Priorita</option>
              <option value="updatedAt">Naposledy upravené</option>
              <option value="createdAt">Najnovšie prípady</option>
            </select>
          </label>
        </div>
      </section>

      <div className="min-h-0 flex-1">
        <CaseTable
          activeCaseId={activeCaseId}
          assets={assets}
          branches={branches}
          calls={calls}
          cases={visibleCases}
          onOpenDetails={onOpenDetails}
          onSortChange={onSortChange}
          operators={operators}
          sort={sort}
          totalCases={totalCases}
        />
      </div>
    </main>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  value: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-base font-medium text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 lg:h-10 lg:text-sm"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
