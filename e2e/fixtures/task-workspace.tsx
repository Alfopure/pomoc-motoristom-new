import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DispatchCase } from "../../src/domain/types";
import type { WorkspaceTask } from "../../src/domain/task-workspace";
import { TaskPanel } from "../../src/components/dispatch/TaskPanel";
import { TaskWorkspaceProvider } from "../../src/components/dispatch/TaskWorkspaceProvider";
const id = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222", caseId = "33333333-3333-4333-8333-333333333333", otherCase = "44444444-4444-4444-8444-444444444444";
const base = { caseId: "", caseIds: [], caseLinks: [], revision: 1, originLocked: false, provenance: "manual" as const, origins: [], updatedAt: "2026-09-10T10:00:00Z", assignedTo: "unassigned", dueAt: "2026-09-10T10:00:00Z", priority: "normal" as const, status: "open" as const, kind: "other" as const };
const tasks: WorkspaceTask[] = [{ ...base, id, title: "Samostatná úloha" }, { ...base, id: second, title: "Úloha pre dva prípady", caseId, caseIds: [caseId, otherCase], caseLinks: [{ caseId, caseNumber: "CASE-001", status: "open" }, { caseId: otherCase, caseNumber: "CASE-002", status: "open" }], originLocked: true, provenance: "proven", origins: [{ sourceType: "callback", sourceId: "callback-fixture", originCaseId: caseId, cancelledAt: null }] }];
const cases = [{ id: caseId, caseNumber: "CASE-001", contact: { name: "Prvý klient" }, tasks: [tasks[1]], vehicle: { licensePlate: "ABC" } }, { id: otherCase, caseNumber: "CASE-002", contact: { name: "Druhý klient" }, tasks: [tasks[1]], vehicle: { licensePlate: "DEF" } }] as unknown as DispatchCase[];
Object.assign(window, { taskWorkspaceFixture: { tasks, cases } });
function App() {
  const [view, setView] = useState<"page" | "sidebar">("page");
  const enabled = new URLSearchParams(location.search).get("legacy") !== "true";
  return <TaskWorkspaceProvider enabled={enabled} initialTasks={tasks}><div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><button style={{ minHeight: 44 }} onClick={() => setView(view === "page" ? "sidebar" : "page")}>Prepnúť zobrazenie</button><div style={{ flex: 1, minHeight: 0 }}><TaskPanel key={view} taskWorkspaceEnabled={enabled} tasks={tasks} variant={view} cases={cases} notifications={[]} operators={[]} onMarkNotificationRead={() => {}} onOpenTask={() => {}} onUpdateTask={async () => { throw new Error("Simulované zlyhanie"); }} /></div></div></TaskWorkspaceProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
