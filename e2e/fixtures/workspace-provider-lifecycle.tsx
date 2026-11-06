import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { NotebookPanel, NotebookProvider } from "../../src/components/dispatch/NotebookPanel";
import { TaskWorkspaceProvider, useTaskWorkspace } from "../../src/components/dispatch/TaskWorkspaceProvider";
import type { WorkspaceTask } from "../../src/domain/task-workspace";
function CaseDraft() {
  const [contact, setContact] = useState("");
  return <label>Rozpracovaný kontakt prípadu<input aria-label="Rozpracovaný kontakt prípadu" value={contact} onChange={event => setContact(event.target.value)} /></label>;
}
function TaskProbe() {
  const { store, snapshot } = useTaskWorkspace();
  return <><output aria-label="Načítané úlohy">{snapshot.tasks.map(task => task.title).join(", ")}</output><button onClick={() => void store.refresh()}>Obnoviť úlohy</button></>;
}
function App() {
  const [enabled, setEnabled] = useState(() => !new URLSearchParams(location.search).has("legacy"));
  const [publishedTasks, setPublishedTasks] = useState("Pôvodná úloha prípadu");
  const publishTasks = useCallback((tasks: WorkspaceTask[]) => setPublishedTasks(tasks.map(task => task.title).join(", ")), []);
  return <><output aria-label="Úlohy prípadu">{publishedTasks}</output><button onClick={() => setEnabled(value => !value)}>Zmeniť dostupnosť nástrojov</button>
    <NotebookProvider actorKey="org:viewer" viewerProfileId="viewer" enabled={enabled}>
      <TaskWorkspaceProvider actorKey="org:viewer" viewerProfileId="viewer" enabled={enabled} onTasksChange={publishTasks}>
        <CaseDraft /><TaskProbe /><NotebookPanel />
      </TaskWorkspaceProvider>
    </NotebookProvider></>;
}
createRoot(document.getElementById("root")!).render(<App />);
