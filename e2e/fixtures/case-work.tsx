import { createRoot } from "react-dom/client";
import { CaseWorkPanel } from "@/components/dispatch/CaseWorkPanel";
import { useState } from "react";
import type { CaseWorkItem } from "@/domain/case-work";
function App() {
  const params = new URLSearchParams(location.search);
  const [active, setActive] = useState(!params.has("hidden"));
  const [kinds, setKinds] = useState<CaseWorkItem["kind"][] | undefined>(
    params.has("dual")
      ? ["tow", "delivery"]
      : params.has("hidden")
        ? ["tow"]
        : undefined,
  );
  return (
    <main style={{ maxWidth: 1040, margin: "auto", padding: 16 }}>
      <button onClick={() => setActive((v) => !v)}>Prepnúť panel</button>
      <button onClick={() => setKinds(["tow", "delivery"])}>
        Pridať pristavenie do prípadu
      </button>
      <div hidden={!active}>
        <CaseWorkPanel
          caseId="72000000-0000-4000-8000-000000000080"
          active={active}
          initialKinds={kinds}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
