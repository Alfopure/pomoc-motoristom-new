import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseTable, type CaseSortState } from "@/components/dispatch/CaseTable";
import { branches, callCenterCalls, dispatchCases, fleetAssets, operators } from "@/mock/seed";

function App() {
  const [sort, setSort] = useState<CaseSortState>({ key: "updatedAt", direction: "desc" });
  const [opened, setOpened] = useState("");
  const cases = Array.from({ length: 24 }, (_, index) => ({
    ...dispatchCases[index % dispatchCases.length],
    id: `fixture-case-${index}`,
    caseNumber: `PM-TEST-${String(index + 1).padStart(4, "0")}`,
    summary: "Porucha vozidla na diaľnici – odťah a náhradné vozidlo. ".repeat(5),
    contact: { ...dispatchCases[0].contact, name: "Testovací klient s dlhým názvom spoločnosti a pobočky", phone: "+421900000000" },
    vehicle: { ...dispatchCases[0].vehicle, licensePlate: "TEST001", issue: "Dlhý popis poruchy motorového vozidla. ".repeat(5) },
  }));
  return <main style={{ height: "100dvh", padding: 16, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
    <output aria-label="Otvorený prípad">{opened}</output>
    <output aria-label="Radenie">{sort.key}:{sort.direction}</output>
    <CaseTable activeCaseId={opened} assets={fleetAssets} branches={branches} calls={callCenterCalls} cases={cases} operators={operators} sort={sort} totalCases={cases.length} storageKey="fixture-case-columns" onOpenDetails={setOpened} onSortChange={setSort} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
