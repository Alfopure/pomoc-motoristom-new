import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseHandoffPanel } from "@/components/dispatch/CaseHandoffPanel";
import { HandoffRecipient } from "@/components/dispatch/HandoffRecipient";
import { LayoutPreviewProvider, useLayoutPreview } from "@/components/dispatch/LayoutPreview";
function Sender() {
  const { mode, setMode } = useLayoutPreview(), [active, setActive] = useState(true);
  return <main data-layout-preview={mode} style={{ padding: 12, maxWidth: 900, margin: "auto" }}><nav><button onClick={() => setMode(mode === "modern" ? "classic" : "modern")}>Prepnúť vzhľad</button><button onClick={() => setActive(value => !value)}>Prepnúť aktívny panel</button></nav><CaseHandoffPanel caseId="20000000-0000-4000-8000-000000000001" caseNumber="PM-2026-100" active={active} /></main>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("sender") ? <LayoutPreviewProvider enabled actorKey="fixture:viewer"><Sender /></LayoutPreviewProvider> : <HandoffRecipient />);
