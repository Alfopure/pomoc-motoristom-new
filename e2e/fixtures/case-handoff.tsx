import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseHandoffPanel } from "@/components/dispatch/CaseHandoffPanel";
import { HandoffRecipient } from "@/components/dispatch/HandoffRecipient";
import { LayoutPreviewProvider } from "@/components/dispatch/LayoutPreview";
import type { LayoutPreviewMode } from "@/components/dispatch/layout-preview-policy";
function Sender({ mode, setMode }: { mode: LayoutPreviewMode; setMode: (mode: LayoutPreviewMode) => void }) {
  const [active, setActive] = useState(true);
  return <main data-layout-preview={mode} style={{ padding: 12, maxWidth: 900, margin: "auto" }}><nav><button onClick={() => setMode(mode === "modern" ? "classic" : "modern")}>Prepnúť vzhľad</button><button onClick={() => setActive(value => !value)}>Prepnúť aktívny panel</button></nav><CaseHandoffPanel caseId="20000000-0000-4000-8000-000000000001" caseNumber="PM-2026-100" active={active} /></main>;
}
function SenderHost() {
  const [mode, setMode] = useState<LayoutPreviewMode>("modern");
  return <LayoutPreviewProvider enabled mode={mode}><Sender mode={mode} setMode={setMode} /></LayoutPreviewProvider>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("sender") ? <SenderHost /> : <HandoffRecipient />);
