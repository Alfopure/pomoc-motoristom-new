"use client";

import { useState } from "react";
import { ArrowUpDown, Building2, CarFront, Clock3, FileText, Filter, ListTodo, MapPinned, MapPin, Search, Table2 } from "lucide-react";
import type { CasePriority, CaseStatus, DispatchCase, Operator } from "@/domain/types";
import { casePriorityLabels, caseStatusLabels, caseStatusTone, priorityTone } from "@/domain/statuses";
import { isTaskOpen } from "@/domain/tasks";
import { caseAssistanceServiceName, formatDateTime, formatTime } from "@/lib/dispatch-calculations";
import type { CaseSortState } from "./CaseTable";

type CenterView = "map" | "table";

export type CaseFilters = {
  status: "all" | CaseStatus;
  priority: "all" | CasePriority;
  ownerId: "all" | string;
  sourceType: "all" | NonNullable<DispatchCase["sourceType"]>;
  assistanceService: "all" | string;
};

type CaseListProps = {
  cases: DispatchCase[];
  operators: Operator[];
  activeCaseId: string;
  activeFilterCount: number;
  assistanceServices: string[];
  centerView: CenterView;
  filters: CaseFilters;
  priorityChangeCaseId?: string | null;
  search: string;
  sort: CaseSortState;
  totalCases: number;
  onChangePriority?: (caseId: string, priority: CasePriority) => void;
  onClearFilters: () => void;
  onFiltersChange: (filters: CaseFilters) => void;
  onOpenDetails: (caseId: string) => void;
  onSearchChange: (value: string) => void;
  onSelect: (caseId: string) => void;
  onSortChange: (sort: CaseSortState) => void;
  onToggleCenterView: () => void;
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

type SidebarSortKey = "priority" | "updatedAt" | "openTasks";

const sidebarSortOptions: Array<{ direction: CaseSortState["direction"]; key: SidebarSortKey; label: string }> = [
  { key: "priority", direction: "asc", label: "Priorita" },
  { key: "updatedAt", direction: "desc", label: "Dátum a čas" },
  { key: "openTasks", direction: "desc", label: "Otvorené úlohy" },
];

export function CaseList({
  cases,
  operators,
  activeCaseId,
  activeFilterCount,
  assistanceServices,
  centerView,
  filters,
  onChangePriority,
  onClearFilters,
  onFiltersChange,
  onOpenDetails,
  onSearchChange,
  onSelect,
  onSortChange,
  onToggleCenterView,
  priorityChangeCaseId,
  search,
  sort,
  totalCases,
}: CaseListProps) {
  const ownerName = (ownerId: string) => operators.find((operator) => operator.id === ownerId)?.name ?? "Nepriradené";
  const [filterOpen, setFilterOpen] = useState(false);
  const ToggleIcon = centerView === "map" ? Table2 : MapPinned;
  const toggleLabel = centerView === "map" ? "Zobraziť tabuľku" : "Zobraziť mapu";
  const sidebarSortKey = sidebarSortOptions.some((option) => option.key === sort.key) ? (sort.key as SidebarSortKey) : "";

  function changeSort(key: SidebarSortKey) {
    const option = sidebarSortOptions.find((candidate) => candidate.key === key);
    if (option) {
      onSortChange({ key: option.key, direction: option.direction });
    }
  }

  return (
    <aside data-testid="dispatch-case-list" className="flex max-h-[38dvh] min-h-[220px] flex-col border-b border-zinc-200 bg-white lg:max-h-none lg:min-h-0 lg:w-full lg:border-b-0 lg:border-r">
      <div className="border-b border-zinc-200 p-1.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-zinc-950">
            <FileText size={13} strokeWidth={2.4} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold tracking-tight text-zinc-950">Aktívne prípady</h2>
            <p className="text-[10px] font-medium leading-3 text-zinc-500">
              {cases.length} z {totalCases}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-500">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              aria-label="Hľadať podľa čísla prípadu, telefónu, EČV alebo mesta"
              className="min-w-0 flex-1 bg-transparent text-zinc-800 outline-none placeholder:text-zinc-400"
              placeholder="Číslo prípadu, telefón, EČV…"
            />
          </label>
          <button
            type="button"
            onClick={() => setFilterOpen((current) => !current)}
            className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-zinc-600 hover:bg-zinc-50 ${
              activeFilterCount > 0 || filterOpen ? "border-yellow-300 bg-yellow-50 text-zinc-950" : "border-zinc-200"
            }`}
            aria-expanded={filterOpen}
            aria-label="Filtre"
            title="Filtre"
          >
            <Filter size={14} />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-950 px-1 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onToggleCenterView}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            <ToggleIcon size={14} />
          </button>
        </div>
        <label className="mt-1.5 grid min-w-0 grid-cols-[30px_auto_minmax(0,1fr)] items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-[11px] font-semibold text-zinc-600 shadow-sm">
          <span className="grid h-8 place-items-center border-r border-yellow-300 bg-[#FCD703] text-zinc-950">
            <ArrowUpDown size={13} aria-hidden="true" />
          </span>
          <span className="shrink-0 px-2">Poradie</span>
          <span className="min-w-0 py-1 pr-1">
            <select
              aria-label="Zoradiť prípady"
              value={sidebarSortKey}
              onChange={(event) => changeSort(event.target.value as SidebarSortKey)}
              className="h-6 w-full min-w-0 rounded-md border border-zinc-200 bg-white pl-2 pr-7 text-[10px] font-semibold text-zinc-900 outline-none transition hover:border-zinc-300 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-200"
            >
              {sidebarSortKey === "" && <option value="" disabled>Iné zoradenie</option>}
              {sidebarSortOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </span>
        </label>
        {filterOpen && (
          <div className="mt-3 grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
            <div className="grid grid-cols-2 gap-2">
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
            <button
              type="button"
              onClick={onClearFilters}
              className="inline-flex h-8 items-center justify-center rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              Vyčistiť
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {cases.length > 0 ? (
          cases.map((caseItem) => {
            const active = activeCaseId === caseItem.id;
            const openTaskCount = caseItem.tasks.filter(isTaskOpen).length;
            const assistanceServiceName = caseAssistanceServiceName(caseItem);
            return (
              <div
                key={caseItem.id}
                data-case-number={caseItem.caseNumber}
                data-case-priority={caseItem.priority}
                data-open-task-count={openTaskCount}
                className={`border-b border-zinc-100 px-1.5 py-0.5 transition ${
                  active ? "bg-yellow-50 ring-1 ring-inset ring-yellow-300" : "bg-white hover:bg-zinc-50"
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      {/* Text musí ostať v <span>: globals.css má nezaradené `button { font: inherit }`,
                          ktoré prebíja Tailwind text-* utility priamo na <button>. */}
                      <button type="button" onClick={() => onSelect(caseItem.id)} className="min-w-0 text-left">
                        <span className="block truncate text-xs font-semibold leading-4 text-zinc-950">{caseItem.caseNumber}</span>
                      </button>
                      {/* Pilulka priority ostáva rovnaký span ako inde; select je neviditeľne
                          položený navrchu, takže zarovnanie sedí a dropdown je natívny. */}
                      {onChangePriority && !active ? (
                        <span className="relative inline-flex rounded-full ring-yellow-300 focus-within:ring-2">
                          <span className={`pointer-events-none rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${priorityTone[caseItem.priority]} ${priorityChangeCaseId === caseItem.id ? "opacity-60" : ""}`}>
                            {casePriorityLabels[caseItem.priority]}
                          </span>
                          <select
                            value={caseItem.priority}
                            disabled={priorityChangeCaseId === caseItem.id}
                            onChange={(event) => onChangePriority(caseItem.id, event.target.value as CasePriority)}
                            className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-wait"
                            aria-label={`Priorita prípadu ${caseItem.caseNumber}`}
                            title="Zmeniť prioritu"
                          >
                            {priorityOptions.map((priority) => (
                              <option key={priority} value={priority}>{casePriorityLabels[priority]}</option>
                            ))}
                          </select>
                        </span>
                      ) : (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${priorityTone[caseItem.priority]}`}
                          title={active ? "Prioritu otvoreného prípadu zmeníš v jeho detaile" : undefined}
                        >
                          {casePriorityLabels[caseItem.priority]}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-700" title={`${openTaskCount} otvorených úloh, ${caseItem.tasks.length} celkom`}>
                        <ListTodo size={10} />
                        Úlohy {openTaskCount}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
                      {caseStatusLabels[caseItem.status]}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenDetails(caseItem.id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100"
                      aria-label={`Detail prípadu ${caseItem.caseNumber}`}
                      title="Detail"
                    >
                      <FileText size={11} />
                    </button>
                  </div>
                </div>

                <button type="button" onClick={() => onSelect(caseItem.id)} className="block w-full text-left">
                  {/* Typografia musí byť na vnútornom prvku: globálne `button { font: inherit }`
                      zámerne drží natívne ovládanie konzistentné, no prebíja text-* na buttonoch. */}
                  <span className="grid w-full gap-0 text-[10px] leading-3.5 text-zinc-600">
                    <span className="inline-flex min-w-0 items-center gap-1.5" title={`${caseItem.caseType || "Bez typu zásahu"} · ${[caseItem.vehicle.licensePlate, caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" · ") || "Vozidlo nezadané"}`}>
                      <CarFront size={11} className="shrink-0 text-zinc-400" />
                      <span className="truncate"><span className="font-medium text-zinc-700">{caseItem.caseType || "Bez typu zásahu"}</span> · {[caseItem.vehicle.licensePlate, caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" · ") || "Vozidlo nezadané"}</span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <MapPin size={11} className="shrink-0 text-zinc-400" />
                      <span className="truncate">{caseItem.pickup?.address || "Poloha nezadaná"}</span>
                    </span>
                    {assistanceServiceName && (
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-amber-800">
                        <Building2 size={11} className="shrink-0 text-amber-600" />
                        <span className="truncate" title={`Asistenčná služba: ${assistanceServiceName}`}>{assistanceServiceName}</span>
                      </span>
                    )}
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Clock3 size={11} className="shrink-0 text-zinc-400" />
                      <span className="truncate" title={`Založené ${formatDateTime(caseItem.createdAt)} · posledná úprava ${formatTime(caseItem.updatedAt)}`}>
                        {formatDateTime(caseItem.createdAt)} · {ownerName(caseItem.ownerId)}
                      </span>
                    </span>
                  </span>
                </button>
              </div>
            );
          })
        ) : (
          <div className="px-4 py-8 text-center text-sm font-medium text-zinc-500">Žiadne prípady nevyhovujú filtru.</div>
        )}
      </div>
    </aside>
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
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2"
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
