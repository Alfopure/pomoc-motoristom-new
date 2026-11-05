import { createRoot } from "react-dom/client";
import { CaseWorkPanel } from "@/components/dispatch/CaseWorkPanel";
import { useState } from "react";
function App() {
  const [active, setActive] = useState(true);
  return (
    <main style={{ maxWidth: 620, margin: "auto", padding: 16 }}>
      <button onClick={() => setActive((v) => !v)}>Prepnúť panel</button>
      <div hidden={!active}>
        <CaseWorkPanel
          caseId="72000000-0000-4000-8000-000000000080"
          active={active}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
