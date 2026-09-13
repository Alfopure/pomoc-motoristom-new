import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DispatchCase, Operator } from "../../src/domain/types";
import type { WorkspaceTask } from "../../src/domain/task-workspace";
import { TaskWorkspacePanel } from "../../src/components/dispatch/TaskWorkspacePanel";
import { TaskWorkspaceProvider } from "../../src/components/dispatch/TaskWorkspaceProvider";

const solver = "11111111-1111-4111-8111-111111111111", reviewer = "22222222-2222-4222-8222-222222222222", other = "33333333-3333-4333-8333-333333333333";
const operators: Operator[] = [{ id: solver, name: "Riešiteľ Peter", extension: "101", status: "available", accessStatus: "active" }, { id: reviewer, name: "Kontrolór Jana", extension: "102", status: "available", accessStatus: "active" }, { id: other, name: "Kolega Martin", extension: "103", status: "available", accessStatus: "active" }];
const base = { title: "Overiť pristavenie vozidla", workflowVersion: 1 as const, workflowState: "todo" as const, reviewerProfileId: null, status: "open" as const, assignedTo: solver, dueAt: "2026-09-14T10:00:00Z", reminderAt: "2026-09-14T09:00:00Z", priority: "normal" as const, kind: "other" as const, caseId: "case-1", caseIds: ["case-1", "case-2"], caseLinks: [{ caseId: "case-1", caseNumber: "PM-2026-101", status: "open" }, { caseId: "case-2", caseNumber: "PM-2026-102", status: "open" }], revision: 1, originLocked: false, provenance: "manual" as const, origins: [], updatedAt: "2026-09-12T10:00:00Z", reviewGeneration: 0 };
const tasks: WorkspaceTask[] = [{ ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...base, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Potvrdiť detaily s klientom", workflowState: "in_progress", dueAt: "2026-09-11T10:00:00Z", priority: "high" }, { ...base, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Schválené podklady", status: "done", workflowState: "done", reviewerProfileId: reviewer, reviewedBy: reviewer, reviewedAt: "2026-09-12T10:00:00Z", reviewGeneration: 1 }];
const cases = [{ id: "case-1", caseNumber: "PM-2026-101", contact: { name: "Ján Novák" } }, { id: "case-2", caseNumber: "PM-2026-102", contact: { name: "Petra Nová" } }] as DispatchCase[];
Object.assign(window, { taskReviewFixture: { tasks, operators, solver, reviewer, other } });
function App() {
  const params = new URLSearchParams(location.search), compact = params.has("compact");
  const [actor, setActor] = useState(solver), [view, setView] = useState<"page" | "sidebar">(params.has("widget") ? "sidebar" : "page");
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "#f5f7fb" }}>
    <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 8, flex: "0 0 auto", font: "12px Arial" }}><label>Testovacia rola <select value={actor} onChange={event => setActor(event.target.value)}>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label><button onClick={() => setView(view === "page" ? "sidebar" : "page")}>Prepnúť pracovný pohľad</button></header>
    <TaskWorkspaceProvider key={actor} enabled viewerProfileId={actor} actorKey={`fixture-org:${actor}`} initialTasks={tasks}><div style={compact ? { height: Number(params.get("panelHeight") ?? 300), width: Number(params.get("panelWidth") ?? 700), maxWidth: "100%", flex: "0 0 auto", minHeight: 0 } : { flex: 1, minHeight: 0 }}><TaskWorkspacePanel tasks={tasks} cases={cases} operators={operators} viewerProfileId={actor} variant={view} compact={compact} /></div></TaskWorkspaceProvider>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
