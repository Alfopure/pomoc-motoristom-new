import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DashboardPhone } from "../../src/components/dispatch/DashboardPhone";
import { SmsComposerDialog } from "../../src/components/dispatch/SmsComposerDialog";
import { UseCustomerLocationButton } from "../../src/components/dispatch/UseCustomerLocationButton";
import { CaseSmsHistory } from "../../src/components/dispatch/CaseSmsHistory";
function Fixture() {
  const [caseId, setCaseId] = useState("case-1");
  const [open, setOpen] = useState(true);
  const global = new URLSearchParams(location.search).has("global");
  Object.assign(window, { changeSmsCase: () => setCaseId("case-2") });
  return <main className="p-6">
    {global ? <DashboardPhone caseContext={{ id: caseId, caseNumber: "PM-123", phone: "+421905999999" }} onDial={() => undefined} onCreateCase={() => { document.body.dataset.created = "true"; }} />
      : <><button type="button" onClick={() => setOpen(true)}>Otvoriť SMS</button><SmsComposerDialog caseId={caseId} caseNumber={caseId === "case-1" ? "PM-123" : "PM-456"} initialPhone="+421905999999" open={open} onClose={() => setOpen(false)} /><CaseSmsHistory caseId="case-1" /><UseCustomerLocationButton caseId="case-1" location={{ lat: 48.1, lng: 17.1, label: "GPS", submittedAt: "2026-09-07T12:00:00Z" }} onNotice={() => undefined} onApplied={() => undefined} /></>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
