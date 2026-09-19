import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseCollaborationProvider, CaseDraftActivity, CaseCollaborationStatus } from "../../src/components/dispatch/CaseCollaborationProvider";
import { CaseDetail } from "../../src/components/dispatch/CaseDetail";
import { NewCaseForm } from "../../src/components/dispatch/NewCaseDrawer";
import type { DispatchCase } from "../../src/domain/types";
import { collaborationCard } from "./case-collaboration-data";
function Fixture() {
  const [cases, setCases] = useState<DispatchCase[]>([collaborationCard]);
  const [creating, setCreating] = useState(false);
  const profile = new URLSearchParams(location.search).get("viewer") ?? "viewer";
  return <CaseCollaborationProvider actorKey={`org:${profile}`} viewerProfileId={profile} enabled initialCases={cases} onCasesChange={setCases}>
    <CaseCollaborationStatus /><CaseDraftActivity />
    <button onClick={() => setCreating(true)}>Vytvoriť nový prípad</button>
    {creating ? <NewCaseForm call={{ id: "call", callerNumber: "", calledNumber: "", lineLabel: "", startedAt: "", waitSeconds: 0, status: "ended", history: [] }} partnerDirectory={[]}
      onClose={() => setCreating(false)} onCreated={data => { setCases(data.dispatchCases); setCreating(false); }} /> : cases[0] ? <CaseDetail caseItem={cases[0]} assets={[]} branches={[]} partnerDirectory={[]} persistentEditing editing
      onDataChange={data => setCases(data.dispatchCases)} onCaseChange={detail => setCases(current => current.map(item => item.id === detail.id ? { ...item, ...detail } : item))} /> : <p>Žiadny prípad</p>}
  </CaseCollaborationProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
