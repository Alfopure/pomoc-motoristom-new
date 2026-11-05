import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseWorkOverview } from "@/components/dispatch/CaseWorkOverview";
function App() {
  const [assigned, setAssigned] = useState(0),
    [active, setActive] = useState(true),
    [refresh, setRefresh] = useState(0);
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button
          onClick={() => setActive((value) => !value)}
          aria-pressed={active}
        >
          Prepnúť aktívny panel
        </button>
        <button onClick={() => setRefresh((value) => value + 1)}>
          Obnoviť dáta zvonka
        </button>
      </div>
      <div hidden={!active}>
        <CaseWorkOverview
          caseId="20000000-0000-4000-8000-000000000001"
          caseNumber="PM-TEST-535"
          jobTypes={["tow", "replacement_vehicle"]}
          active={active}
          refreshToken={refresh}
          onAssign={() => setAssigned((value) => value + 1)}
        />
      </div>
      {assigned > 0 && <p role="status">Odovzdanie otvorené {assigned}</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
