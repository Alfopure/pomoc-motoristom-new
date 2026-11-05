"use client";

import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { CaseTable, type CaseSortState } from "./CaseTable";
import { CaseStatusFilter } from "./CaseStatusFilter";
import type { CaseFilters } from "./CaseList";
import { CaseAccessBoundary, CaseDraftActivity } from "./CaseCollaborationProvider";
import { countCaseOverviewFilters } from "./case-overview-filters";
import type { CallCenterCall } from "@/data/dispatch-types";
import { jobTypeLabels } from "@/domain/case-card";
import { casePriorityLabels } from "@/domain/statuses";
import type { CasePriority, DispatchCase, FleetAsset, Branch, Operator } from "@/domain/types";
import styles from "./case-directory.module.css";

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
  storageKey?: string;
  workspaceMode?: "collapsed" | "split" | "expanded";
  scopeCounts?: { active: number; closed: number; all: number };
  onClearFilters: () => void;
  onFiltersChange: (filters: CaseFilters) => void;
  onNewCase: () => void;
  onOpenDetails: (caseId: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (sort: CaseSortState) => void;
};

const priorityOptions: CasePriority[] = ["urgent", "high", "normal", "low"];
type CaseSourceType = NonNullable<DispatchCase["sourceType"]>;
const sourceLabels: Record<CaseSourceType, string> = {
  client: "Klient", assistance: "Asistenčka", samoplatca: "Samoplatca", partner: "Partner", internal: "Interné",
};
const scopes = [{ key: "active", label: "Aktívne" }, { key: "closed", label: "História" }, { key: "all", label: "Všetky" }] as const;
const sortOptions: Array<[CaseSortState["key"], string]> = [
  ["updatedAt", "Naposledy upravené"], ["createdAt", "Dátum založenia"], ["priority", "Priorita"],
  ["caseNumber", "Číslo prípadu"], ["status", "Stav"], ["caller", "Kontakt"], ["owner", "Operátor"],
  ["vehicle", "Vozidlo"], ["openTasks", "Otvorené úlohy"],
];

export function CaseDirectory({
  activeCaseId, activeFilterCount, assets, assistanceServices, branches, calls, cases, filters,
  onClearFilters, onFiltersChange, onNewCase, onOpenDetails, onSearchChange, onSortChange,
  operators, search, sort, totalCases, storageKey, workspaceMode, scopeCounts,
}: CaseDirectoryProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const additionalFilterCount = countCaseOverviewFilters(filters) + [
    filters.priority !== "all", filters.ownerId !== "all", filters.sourceType !== "all",
    filters.assistanceService !== "all", !["active", "closed", "all"].includes(filters.status),
  ].filter(Boolean).length;
  const modified = Boolean(search.trim()) || additionalFilterCount > 0;
  const invalidPeriod = Boolean(filters.createdFrom && filters.createdTo && filters.createdFrom > filters.createdTo);

  return <CaseAccessBoundary>
    <section className={styles.directory} aria-label="Prehľad prípadov">
      <CaseDraftActivity />
      <div className={styles.controls}>
        <div className={styles.searchRow}>
          <div className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <input ref={inputRef} type="search" value={search} onChange={event => onSearchChange(event.target.value)}
              aria-label="Hľadať prípady v adresári" placeholder="Číslo prípadu, meno, telefón, EČV, miesto…" />
            {search && <button type="button" className={styles.clearSearch} aria-label="Vymazať hľadanie prípadov"
              onClick={() => { onSearchChange(""); inputRef.current?.focus(); }}><X size={15} aria-hidden="true" /></button>}
          </div>
          <button type="button" aria-expanded={filtersOpen} aria-controls={filtersId}
            className={`${styles.button} ${additionalFilterCount ? styles.filtered : ""}`}
            onClick={() => setFiltersOpen(value => !value)}>
            <SlidersHorizontal size={15} aria-hidden="true" />Filtre{additionalFilterCount ? ` (${additionalFilterCount})` : ""}
          </button>
          <button type="button" className={`${styles.button} ${styles.newCase}`} onClick={onNewCase}>
            <Plus size={15} aria-hidden="true" />Nový prípad
          </button>
        </div>
        <div className={styles.scopeRow}>
          <div className={styles.scopes} role="group" aria-label="Rozsah prípadov">
            {scopes.map(scope => <button key={scope.key} type="button" aria-pressed={filters.status === scope.key}
              onClick={() => onFiltersChange({ ...filters, status: scope.key, statusTouched: true })}>
              {scope.label}{scopeCounts && <span>{scopeCounts[scope.key]}</span>}
            </button>)}
          </div>
          <div className={styles.sort}>
            <label>Poradie
              <select aria-label="Zoradiť adresár prípadov" value={sort.key}
                onChange={event => onSortChange({ key: event.target.value as CaseSortState["key"], direction: event.target.value === "priority" ? "asc" : "desc" })}>
                {!sortOptions.some(([key]) => key === sort.key) && <option value={sort.key}>Vlastný stĺpec</option>}
                {sortOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <button type="button" className={styles.direction} aria-label={sort.direction === "desc" ? "Zoradiť vzostupne" : "Zoradiť zostupne"}
              title={sort.direction === "desc" ? "Zostupné poradie" : "Vzostupné poradie"}
              onClick={() => onSortChange({ ...sort, direction: sort.direction === "desc" ? "asc" : "desc" })}>
              {sort.direction === "desc" ? <ArrowDown size={15} aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />}
            </button>
          </div>
          {modified && <button type="button" className={styles.reset} onClick={onClearFilters}>
            <RotateCcw size={14} aria-hidden="true" />Vyčistiť
          </button>}
        </div>
        <div id={filtersId} hidden={!filtersOpen} className={styles.advanced}>
          <CaseStatusFilter filters={filters} onChange={onFiltersChange} searching={Boolean(search.trim()) && !filters.statusTouched} />
          <FilterSelect label="Priorita" value={filters.priority} onChange={value => onFiltersChange({ ...filters, priority: value as CaseFilters["priority"] })}
            options={[["all", "Všetky priority"], ...priorityOptions.map(priority => [priority, casePriorityLabels[priority]] as const)]} />
          <FilterSelect label="Operátor" value={filters.ownerId} onChange={value => onFiltersChange({ ...filters, ownerId: value })}
            options={[["all", "Všetci operátori"], ...operators.map(operator => [operator.id, operator.name] as const)]} />
          <FilterSelect label="Pobočka" value={filters.branchId || "all"} onChange={value => onFiltersChange({ ...filters, branchId: value })}
            options={[["all", "Všetky pobočky"], ...branches.map(branch => [branch.id, branch.name] as const)]} />
          <FilterSelect label="Druh práce" value={filters.jobType || "all"} onChange={value => onFiltersChange({ ...filters, jobType: value as CaseFilters["jobType"] })}
            options={[["all", "Všetky práce"], ...Object.entries(jobTypeLabels)]} />
          <FilterSelect label="Zdroj" value={filters.sourceType} onChange={value => onFiltersChange({ ...filters, sourceType: value as CaseFilters["sourceType"] })}
            options={[["all", "Všetky zdroje"], ...Object.entries(sourceLabels)]} />
          <FilterSelect label="Asistenčná služba" value={filters.assistanceService} onChange={value => onFiltersChange({ ...filters, assistanceService: value })}
            options={[["all", "Všetky asistenčky"], ...assistanceServices.map(name => [name, name] as const)]} />
          <div className={styles.period}>
            <label>Založené od<input type="date" aria-label="Založené od" value={filters.createdFrom || ""} max={filters.createdTo || undefined}
              aria-invalid={invalidPeriod || undefined} aria-describedby={invalidPeriod ? `${filtersId}-period-error` : undefined}
              onChange={event => onFiltersChange({ ...filters, createdFrom: event.target.value })} /></label>
            <label>Založené do<input type="date" aria-label="Založené do" value={filters.createdTo || ""} min={filters.createdFrom || undefined}
              aria-invalid={invalidPeriod || undefined} aria-describedby={invalidPeriod ? `${filtersId}-period-error` : undefined}
              onChange={event => onFiltersChange({ ...filters, createdTo: event.target.value })} /></label>
            {invalidPeriod && <p id={`${filtersId}-period-error`} role="alert">Dátum „od“ musí byť pred dátumom „do“.</p>}
          </div>
        </div>
      </div>
      {cases.length === 0 && modified && <div className={styles.emptyHint} role="status">
        Žiadny prípad nevyhovuje výberu. <button type="button" onClick={onClearFilters}>Vyčistiť hľadanie a filtre</button>
      </div>}
      <div className={styles.table} data-filter-count={activeFilterCount}>
        <CaseTable activeCaseId={activeCaseId} assets={assets} branches={branches} calls={calls} cases={cases}
          onOpenDetails={onOpenDetails} onSortChange={onSortChange} operators={operators} sort={sort}
          storageKey={storageKey} totalCases={totalCases} workspaceMode={workspaceMode} />
      </div>
    </section>
  </CaseAccessBoundary>;
}

function FilterSelect({ label, onChange, options, value }: {
  label: string; onChange: (value: string) => void; options: ReadonlyArray<readonly [string, string]>; value: string;
}) {
  return <label className={styles.field}>{label}
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
    </select>
  </label>;
}
