import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NotebookPanel, NotebookProvider } from "../../src/components/dispatch/NotebookPanel";
import { TaskWorkspaceProvider, useTaskWorkspace } from "../../src/components/dispatch/TaskWorkspaceProvider";
function CaseDraft() {
  const [contact, setContact] = useState("");
  return <label>Rozpracovaný kontakt prípadu<input aria-label="Rozpracovaný kontakt prípadu" value={contact} onChange={event => setContact(event.target.value)} /></label>;
}
function TaskProbe() {
  const { snapshot } = useTaskWorkspace();
  return <output aria-label="Načítané úlohy">{snapshot.tasks.map(task => task.title).join(", ")}</output>;
}
function App() {
  const [enabled, setEnabled] = useState(true);
  return <><button onClick={() => setEnabled(value => !value)}>Zmeniť dostupnosť nástrojov</button>
    <NotebookProvider actorKey="org:viewer" viewerProfileId="viewer" enabled={enabled}>
      <TaskWorkspaceProvider actorKey="org:viewer" viewerProfileId="viewer" enabled={enabled}>
        <CaseDraft /><TaskProbe /><NotebookPanel />
      </TaskWorkspaceProvider>
    </NotebookProvider></>;
}
createRoot(document.getElementById("root")!).render(<App />);
