import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseCollaborationProvider } from "../../src/components/dispatch/CaseCollaborationProvider";
import { ExpandedCasePanel } from "../../src/components/dispatch/ExpandedCasePanel";
import type { DispatchCase } from "../../src/domain/types";

function Fixture() {
  const [cases, setCases] = useState<DispatchCase[]>([]);
  const [created, setCreated] = useState<{ id: string; openHandoff: boolean; notice?: string } | null>(null);
  const card = created ? cases.find(item => item.id === created.id) : undefined;
  return <CaseCollaborationProvider actorKey="fixture-org:fixture-operator" viewerProfileId="fixture-operator" enabled initialCases={cases} onCasesChange={setCases}>
    <main style={{ height: "100vh", maxWidth: 1200, margin: "auto" }}>
      {created?.notice && <p role="status">{created.notice}</p>}
      <ExpandedCasePanel
        active assets={[]} branches={[]} commanderVehicles={[]} operators={[]} partnerDirectory={[]}
        call={{ id: "fixture-call", callerNumber: "", calledNumber: "", lineLabel: "", startedAt: "", waitSeconds: 0, status: "ended", history: [] }}
        kind={created ? "detail" : "new"} caseItem={card} openHandoff={created?.openHandoff}
        onBackToCockpit={() => {}}
        onCaseCreated={(data, id, notice, openHandoff = false) => {
          setCases(data.dispatchCases);
          setCreated({ id, notice, openHandoff });
        }}
        onDataChange={data => setCases(data.dispatchCases)}
        onCaseChange={detail => setCases(current => current.map(item => item.id === detail.id ? { ...item, ...detail } : item))}
      />
    </main>
  </CaseCollaborationProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
