import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WidgetHost } from "@/components/dispatch/WidgetHost";
import { CalculatorWidget } from "@/components/dispatch/CalculatorWidget";
import { CalendarWidget } from "@/components/dispatch/CalendarWidget";
import { NotebookPanel, NotebookProvider } from "@/components/dispatch/NotebookPanel";
import { TaskWorkspaceProvider, useTaskWorkspace } from "@/components/dispatch/TaskWorkspaceProvider";
import { defaultWorkspacePreferences } from "@/components/dispatch/workspace-preferences";
import { LayoutPreviewProvider, useLayoutPreview } from "@/components/dispatch/LayoutPreview";
import { layoutPreviewEnabled } from "@/components/dispatch/layout-preview-policy";
import "@/components/dispatch/workspace-tools.css";

function Fixture() {
  const { mode, setMode } = useLayoutPreview();
  const [settings, setSettings] = useState(false);
  const [preferences, setPreferences] = useState(() => ({ ...defaultWorkspacePreferences(), widgets: defaultWorkspacePreferences().widgets.map(widget => ({ ...widget, visible: ["calculator", "calendar", "notes"].includes(widget.id) })) }));
  const [opened, setOpened] = useState("");
  const { store } = useTaskWorkspace();
  return <main className="widget-fixture" data-layout-preview={mode}>
    <nav aria-label="Ovládanie testovacej ukážky" className="mb-2 flex flex-wrap gap-2">
      <button onClick={() => setMode(mode === "modern" ? "classic" : "modern")}>Prepnúť vzhľad</button>
      <button onClick={() => store.clear()}>Zrušiť prístup k úlohám</button>
      <button onClick={() => setPreferences(current => ({ ...current, leftCollapsed: true, rightCollapsed: true, centerView: "notes" }))}>Upraviť rozloženie pracoviska</button>
    </nav>
    <output aria-label="Otvorená úloha">{opened}</output>
    <output className="sr-only" aria-label="Rozloženie pracoviska">{`${preferences.leftCollapsed}:${preferences.rightCollapsed}:${preferences.centerView}`}</output>
    <WidgetHost preferences={preferences} onChange={setPreferences} expanded settingsOpen={settings} onSettingsChange={setSettings} onClose={() => undefined} renderWidget={(id, active) => {
      if (id === "calculator") return <CalculatorWidget />;
      if (id === "calendar") return <CalendarWidget onOpenTask={(taskId, caseId) => setOpened(`${taskId}:${caseId}`)} />;
      if (id === "notes") return <NotebookPanel active={active} compact />;
      return <p className="p-2">Existujúci nástroj {id}</p>;
    }} />
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <LayoutPreviewProvider enabled={layoutPreviewEnabled({ VERCEL_ENV: new URLSearchParams(location.search).has("production") ? "production" : "preview", NODE_ENV: "production" })} actorKey="fixture:viewer"><NotebookProvider actorKey="fixture:viewer" viewerProfileId="viewer" enabled>
    <TaskWorkspaceProvider actorKey="fixture:viewer" viewerProfileId="viewer" enabled><Fixture /></TaskWorkspaceProvider>
  </NotebookProvider></LayoutPreviewProvider>,
);
