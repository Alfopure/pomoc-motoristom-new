"use client";

import { caseStatusLabels } from "@/domain/statuses";
import type { CaseStatus } from "@/domain/types";
import type { CaseFilters } from "./CaseList";
import type { CaseStatusSelection } from "./case-status-filter";

export function CaseStatusFilter({ filters, onChange, searching = false }: { filters: CaseFilters; onChange: (filters: CaseFilters) => void; searching?: boolean }) {
  return <div className="min-w-0">
    <label className="grid gap-1 text-xs font-semibold text-zinc-600">Stav
      <select aria-label="Stav" value={filters.status} disabled={searching} onChange={event => onChange({ ...filters, status: event.target.value as CaseStatusSelection, statusTouched: true })} className="h-11 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-base text-zinc-900 disabled:bg-zinc-50 lg:h-9 lg:text-xs">
        <option value="active">Aktívne stavy</option><option value="all">Všetky stavy</option><option value="closed">Ukončené stavy</option><option value="selected">Vybrať viac stavov…</option>
        {(Object.keys(caseStatusLabels) as CaseStatus[]).map(status => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
      </select>
    </label>
    {searching && <p className="mt-1 text-xs font-normal text-zinc-600">Vyhľadáva sa vo všetkých stavoch.</p>}
    {filters.status === "selected" && <fieldset className="mt-2 grid gap-1 rounded-md border border-zinc-200 bg-white p-2"><legend className="px-1 text-xs text-zinc-600">Vybrané stavy ({filters.statuses?.length ?? 0})</legend>{(Object.keys(caseStatusLabels) as CaseStatus[]).map(status => <label key={status} className="flex min-h-9 items-center gap-2 text-xs text-zinc-800"><input type="checkbox" checked={filters.statuses?.includes(status) ?? false} onChange={event => onChange({ ...filters, statusTouched: true, statuses: event.target.checked ? [...(filters.statuses ?? []), status] : filters.statuses?.filter(value => value !== status) })} />{caseStatusLabels[status]}</label>)}</fieldset>}
  </div>;
}
