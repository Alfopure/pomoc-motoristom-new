"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, RotateCcw, Settings2, X } from "lucide-react";
import { defaultWorkspacePreferences, moveWidget, WIDGET_LABELS, type WidgetId, type WorkspacePreferences } from "./workspace-preferences";

const action = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:opacity-30";

/** One stable host changes layout across breakpoints; hiding a widget retains its local draft. */
export function WidgetHost({ preferences, onChange, renderWidget, onClose, expanded, active = true }: {
  preferences: WorkspacePreferences;
  onChange: (next: WorkspacePreferences) => void;
  renderWidget: (id: WidgetId, active: boolean) => ReactNode;
  onClose: () => void;
  expanded: boolean;
  active?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragged, setDragged] = useState<WidgetId | null>(null);
  const [notice, setNotice] = useState("");
  function move(id: WidgetId, index: number) {
    onChange({ ...preferences, widgets: moveWidget(preferences.widgets, id, index) });
    setNotice(`${WIDGET_LABELS[id]}: pozícia ${index + 1}.`);
  }
  return <aside aria-label="Nástroje" className={`dispatch-widget-host min-h-0 min-w-0 flex-col border-l border-zinc-200 bg-white ${expanded ? "is-open" : ""}`}>
    <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3">
      <h2 className="text-sm font-semibold">Nástroje</h2>
      <div className="flex"><button type="button" className={action} aria-label="Nastaviť widgety" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={18} /></button><button type="button" className={action} aria-label="Zbaliť nástroje" onClick={onClose}><X size={18} /></button></div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {settingsOpen && <section aria-label="Nastavenie widgetov" className="space-y-1 border-b border-zinc-200 bg-zinc-50 p-3">
        <p className="mb-2 text-xs text-zinc-600">Poradie a zobrazenie sa ukladajú pre vás v tomto prehliadači.</p>
        {preferences.widgets.map((widget, index) => <div key={widget.id} draggable onDragStart={() => setDragged(widget.id)} onDragEnd={() => setDragged(null)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged) move(dragged, index); setDragged(null); }} className="flex min-w-0 items-center gap-1 rounded-lg bg-white px-1">
          <GripVertical size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm"><input type="checkbox" checked={widget.visible} onChange={event => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, visible: event.target.checked } : item) })} />{WIDGET_LABELS[widget.id]}</label>
          <button type="button" disabled={index === 0} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť vyššie`} onClick={() => move(widget.id, index - 1)}><ArrowUp size={16} /></button>
          <button type="button" disabled={index === preferences.widgets.length - 1} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť nižšie`} onClick={() => move(widget.id, index + 1)}><ArrowDown size={16} /></button>
        </div>)}
        <button type="button" className="flex min-h-11 items-center gap-2 text-sm" onClick={() => { onChange(defaultWorkspacePreferences()); setNotice("Predvolené rozloženie obnovené."); }}><RotateCcw size={16} />Obnoviť predvolené rozloženie</button>
      </section>}
      <p className="sr-only" role="status">{notice}</p>
      {preferences.widgets.every(widget => !widget.visible) && <p className="p-4 text-sm text-zinc-500">Vyberte si nástroje cez nastavenie widgetov.</p>}
      {preferences.widgets.map(widget => <section key={widget.id} hidden={!widget.visible} data-widget={widget.id} className="border-b border-zinc-200">
        <button type="button" aria-expanded={!widget.collapsed} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-sm font-semibold hover:bg-zinc-50" onClick={() => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, collapsed: !item.collapsed } : item) })}>
          {WIDGET_LABELS[widget.id]}{widget.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <div hidden={widget.collapsed}>{renderWidget(widget.id, active && widget.visible && !widget.collapsed)}</div>
      </section>)}
    </div>
  </aside>;
}
