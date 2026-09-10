"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, RotateCcw, Settings2, X } from "lucide-react";
import { defaultWorkspacePreferences, moveWidget, WIDGET_LABELS, type WidgetId, type WorkspacePreferences } from "./workspace-preferences";

const action = "widget-host-action inline-flex items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:opacity-30";

/** One stable host changes layout across breakpoints; hiding a widget retains its local draft. */
export function WidgetHost({ preferences, onChange, renderWidget, onClose, expanded, settingsOpen, onSettingsChange, active = true }: {
  preferences: WorkspacePreferences;
  onChange: (next: WorkspacePreferences) => void;
  renderWidget: (id: WidgetId, active: boolean) => ReactNode;
  onClose: () => void;
  expanded: boolean;
  settingsOpen: boolean;
  onSettingsChange: (open: boolean) => void;
  active?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [dragged, setDragged] = useState<WidgetId | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (expanded) headingRef.current?.focus({ preventScroll: true });
  }, [expanded]);
  function move(id: WidgetId, index: number) {
    onChange({ ...preferences, widgets: moveWidget(preferences.widgets, id, index) });
    setNotice(`${WIDGET_LABELS[id]}: pozícia ${index + 1}.`);
  }
  return <aside id="dispatch-tools-panel" aria-label="Nástroje" data-settings-open={settingsOpen} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }} className={`dispatch-widget-host min-h-0 min-w-0 flex-col border-l border-zinc-200 bg-white ${expanded ? "is-open" : ""}`}>
    <div className="widget-host-header flex shrink-0 items-center justify-between border-b border-zinc-200 px-3">
      <h2 ref={headingRef} tabIndex={-1} className="text-[13px] font-semibold outline-none">Nástroje</h2>
      <div className="flex"><button type="button" className={action} aria-label="Nastaviť widgety" aria-expanded={settingsOpen} aria-controls="widget-settings" onClick={() => onSettingsChange(!settingsOpen)}><Settings2 size={16} /></button><button type="button" className={action} aria-label="Zbaliť nástroje" onClick={onClose}><X size={16} /></button></div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {settingsOpen && <section id="widget-settings" aria-label="Nastavenie widgetov" className="widget-settings space-y-1 border-b border-zinc-200 bg-zinc-50 p-3">
        <h3 className="text-xs font-semibold text-zinc-900">Vaše widgety</h3>
        <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">Zapnite si potrebné nástroje a upravte ich poradie. Výber sa uloží v tomto prehliadači.</p>
        {preferences.widgets.map((widget, index) => <div key={widget.id} draggable onDragStart={() => setDragged(widget.id)} onDragEnd={() => setDragged(null)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged) move(dragged, index); setDragged(null); }} className="flex min-w-0 items-center gap-1 rounded-md border border-zinc-200/70 bg-white px-1">
          <GripVertical size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <label className="widget-setting-label flex min-w-0 flex-1 items-center gap-2 text-xs"><input type="checkbox" checked={widget.visible} onChange={event => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, visible: event.target.checked } : item) })} />{WIDGET_LABELS[widget.id]}</label>
          <button type="button" disabled={index === 0} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť vyššie`} onClick={() => move(widget.id, index - 1)}><ArrowUp size={16} /></button>
          <button type="button" disabled={index === preferences.widgets.length - 1} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť nižšie`} onClick={() => move(widget.id, index + 1)}><ArrowDown size={16} /></button>
        </div>)}
        <button type="button" className="widget-reset flex items-center gap-2 text-xs text-zinc-600 hover:text-zinc-950" onClick={() => { onChange(defaultWorkspacePreferences()); setNotice("Predvolené rozloženie obnovené."); }}><RotateCcw size={14} />Obnoviť predvolené rozloženie</button>
      </section>}
      <p className="sr-only" role="status">{notice}</p>
      {preferences.widgets.every(widget => !widget.visible) && <p className="p-4 text-sm text-zinc-500">Vyberte si nástroje cez nastavenie widgetov.</p>}
      {preferences.widgets.map(widget => <section key={widget.id} hidden={!widget.visible} data-widget={widget.id} className="border-b border-zinc-200">
        <button type="button" aria-expanded={!widget.collapsed} className="widget-section-toggle flex w-full items-center justify-between gap-2 px-3 text-left text-xs font-semibold hover:bg-zinc-50" onClick={() => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, collapsed: !item.collapsed } : item) })}>
          {WIDGET_LABELS[widget.id]}{widget.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <div hidden={widget.collapsed}>{renderWidget(widget.id, active && widget.visible && !widget.collapsed)}</div>
      </section>)}
    </div>
  </aside>;
}
