import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseWorkspace } from "@/components/dispatch/CaseWorkspace";
import { dispatchCases } from "@/mock/seed";

const lifecycle = { mounts: 0, unmounts: 0 };
Object.assign(window, { sharedWorkspaceLifecycle: lifecycle });
function ManagementDraft() {
  const [value, setValue] = useState("");
  useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++; }; }, []);
  return <section aria-label="Rozpracovaná správa práce"><label>Pokyny rozpracovanej práce<input value={value} onChange={event => setValue(event.target.value)} style={{ width: "100%", maxWidth: 340 }} /></label></section>;
}
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 1100, margin: "auto", padding: 16 }}><CaseWorkspace caseItem={dispatchCases[0]} assets={[]} operators={[]} handoff={null} work={<ManagementDraft />} tasks={<p>Úlohy prípadu</p>} partner={<p>Partner prípadu</p>} notes={<p>Poznámky prípadu</p>} sms={<p>SMS prípadu</p>} /></main>);
