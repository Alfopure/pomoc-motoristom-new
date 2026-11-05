import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseDirectory } from "@/components/dispatch/CaseDirectory";
import type { CaseFilters } from "@/components/dispatch/CaseList";
import type { CaseSortState } from "@/components/dispatch/CaseTable";
import { matchesCaseStatus } from "@/components/dispatch/case-status-filter";
import { matchesCaseOverviewFilters } from "@/components/dispatch/case-overview-filters";
import { branches, dispatchCases } from "@/mock/seed";
const baseline: CaseFilters = { status: "all", priority: "all", ownerId: "all", sourceType: "all", assistanceService: "all" };
const items = [
  { ...dispatchCases[0], id: "directory-active", caseNumber: "PM-DIR-001", status: "new" as const, jobTypes: ["tow" as const, "replacement_vehicle" as const], branchId: "ba", createdAt: "2026-11-05T23:30:00Z" },
  { ...dispatchCases[0], id: "directory-closed", caseNumber: "PM-DIR-002", status: "completed_assisted" as const, jobTypes: ["replacement_vehicle" as const], branchId: "ke", createdAt: "2026-10-01T10:30:00Z" },
  { ...dispatchCases[0], id: "directory-assigned", caseNumber: "PM-DIR-003", status: "assigned" as const, jobTypes: ["tow" as const], branchId: "ba", createdAt: "2026-11-06T10:30:00Z" },
];
function App() {
  const [filters, setFilters] = useState(baseline), [search, setSearch] = useState("");
  const [sort, setSort] = useState<CaseSortState>({ key: "updatedAt", direction: "desc" });
  const [opened, setOpened] = useState(""), [created, setCreated] = useState(0);
  const cases = items.filter(item => matchesCaseStatus(item.status, filters.status, filters.statuses) && matchesCaseOverviewFilters(item, filters)
    && (!search || item.caseNumber.toLowerCase().includes(search.toLowerCase())));
  return <main style={{ height: "100dvh", minWidth: 0, padding: 10, display: "flex", flexDirection: "column" }}>
    <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}><CaseDirectory activeCaseId="" activeFilterCount={0} assets={[]} assistanceServices={[]} branches={[{ ...branches[0], id: "ba", name: "Bratislava" }, { ...branches[0], id: "ke", name: "Košice" }]} calls={[]} cases={cases} filters={filters}
      onClearFilters={() => { setFilters(baseline); setSearch(""); }} onFiltersChange={setFilters} onNewCase={() => setCreated(value => value + 1)}
      onOpenDetails={setOpened} onSearchChange={setSearch} onSortChange={setSort} operators={[]} search={search} sort={sort} totalCases={items.length}
      storageKey="fixture-directory-columns" scopeCounts={{ active: 2, closed: 1, all: 3 }} /></div>
    <output aria-label="Stav prehľadu" style={{ fontSize: 10, overflowWrap: "anywhere", minWidth: 0 }}>{JSON.stringify({ filters, search, sort, opened, created })}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
