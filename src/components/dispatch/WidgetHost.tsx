"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Calculator, CalendarDays, CarFront, CheckCheck, ChevronDown, ChevronUp, GripVertical, Phone, Plus, RotateCcw, Route, Search, Settings2, StickyNote, X, type LucideIcon } from "lucide-react";
import { defaultWorkspacePreferences, moveWidget, WIDGET_LABELS, type WidgetId, type WorkspacePreferences } from "./workspace-preferences";
import { useLayoutPreview } from "./LayoutPreview";
import "./live-widget-preview.css";

const action = "widget-host-action inline-flex items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:opacity-30";
const widgetIdentity: Record<WidgetId, { icon: LucideIcon; description: string }> = {
  phone: { icon: Phone, description: "Čísla a hovory po ruke" },
  tasks: { icon: CheckCheck, description: "Úlohy a ich aktuálny stav" },
  notes: { icon: StickyNote, description: "Váš blok a zdieľané poznámky" },
  calculator: { icon: Calculator, description: "Výpočty bez opustenia prípadu" },
  route: { icon: Route, description: "Zastávky a plánovanie cesty" },
  search: { icon: Search, description: "Rýchle hľadanie v pracovisku" },
  fleet: { icon: CarFront, description: "Vozidlá a ich dostupnosť" },
  calendar: { icon: CalendarDays, description: "Termíny a denná agenda úloh" },
};

function WidgetIcon({ id }: { id: WidgetId }) {
  const Icon = widgetIdentity[id].icon;
  return <span className="widget-app-icon widget-modern-only" data-widget-icon={id} aria-hidden="true"><Icon size={16} /></span>;
}

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
  const { enabled: previewEnabled } = useLayoutPreview();
  // Preserve the preference if this browser previously visited Preview, while
  // keeping the additional widget out of the production controls and tree.
  const widgets = preferences.widgets.filter(widget => widget.id !== "calendar" || previewEnabled);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<WidgetId | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (expanded) headingRef.current?.focus({ preventScroll: true });
  }, [expanded]);
  function move(id: WidgetId, index: number) {
    const destination = preferences.widgets.findIndex(widget => widget.id === widgets[index]?.id);
    onChange({ ...preferences, widgets: moveWidget(preferences.widgets, id, destination) });
    setNotice(`${WIDGET_LABELS[id]}: pozícia ${index + 1}.`);
  }
  return <aside id="dispatch-tools-panel" aria-label="Nástroje" data-settings-open={settingsOpen} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }} className={`dispatch-widget-host min-h-0 min-w-0 flex-col border-l border-zinc-200 bg-white ${expanded ? "is-open" : ""}`}>
    <div className="widget-host-header flex shrink-0 items-center justify-between border-b border-zinc-200 px-3">
      <div className="widget-host-title"><span className="widget-eyebrow widget-modern-only">Vaše pracovisko</span><h2 ref={headingRef} tabIndex={-1} className="text-[13px] font-semibold outline-none">Nástroje</h2></div>
      <div className="flex"><button type="button" className={action} aria-label="Nastaviť widgety" aria-expanded={settingsOpen} aria-controls="widget-settings" onClick={() => onSettingsChange(!settingsOpen)}><Settings2 size={16} /></button><button type="button" className={action} aria-label="Zbaliť nástroje" onClick={onClose}><X size={16} /></button></div>
    </div>
    <div className="widget-quick-launch widget-modern-only" role="group" aria-label="Rýchlo otvoriť nástroj">
      {(["notes", "calculator", ...(previewEnabled ? ["calendar"] : [])] as WidgetId[]).map(id => <button type="button" key={id} aria-label={`Otvoriť nástroj ${WIDGET_LABELS[id]}`} onClick={() => {
        onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === id ? { ...item, visible: true, collapsed: false } : item) });
        onSettingsChange(false);
        requestAnimationFrame(() => {
          const scroller = scrollRef.current;
          const target = scroller?.querySelector<HTMLElement>(`[data-widget="${id}"]`);
          if (scroller && target) { scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8 }); target.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }
        });
      }}><WidgetIcon id={id} /><span>{WIDGET_LABELS[id]}</span></button>)}
    </div>
    <div ref={scrollRef} className="widget-host-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {settingsOpen && <section id="widget-settings" aria-label="Nastavenie widgetov" className="widget-settings space-y-1 border-b border-zinc-200 bg-zinc-50 p-3">
        <h3 className="text-xs font-semibold text-zinc-900">Vaše widgety</h3>
        <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">Zapnite, čo používate. Najdôležitejší nástroj presuňte hore. Skrytie zachová jeho obsah; výber sa uloží v tomto prehliadači.</p>
        {widgets.map((widget, index) => <div key={widget.id} draggable data-widget-setting={widget.id} data-visible={widget.visible} onDragStart={() => setDragged(widget.id)} onDragEnd={() => setDragged(null)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged) move(dragged, index); setDragged(null); }} className="widget-gallery-item flex min-w-0 items-center gap-1 rounded-md border border-zinc-200/70 bg-white px-1">
          <GripVertical size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <label className="widget-setting-label flex min-w-0 flex-1 items-center gap-2 text-xs"><input type="checkbox" aria-label={WIDGET_LABELS[widget.id]} checked={widget.visible} onChange={event => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, visible: event.target.checked } : item) })} /><WidgetIcon id={widget.id} /><span className="widget-setting-copy"><strong>{WIDGET_LABELS[widget.id]}</strong><span className="widget-modern-only">{widgetIdentity[widget.id].description}</span></span></label>
          <button type="button" disabled={index === 0} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť vyššie`} onClick={() => move(widget.id, index - 1)}><ArrowUp size={16} /></button>
          <button type="button" disabled={index === widgets.length - 1} className={action} aria-label={`${WIDGET_LABELS[widget.id]} posunúť nižšie`} onClick={() => move(widget.id, index + 1)}><ArrowDown size={16} /></button>
        </div>)}
        <button type="button" className="widget-reset flex items-center gap-2 text-xs text-zinc-600 hover:text-zinc-950" onClick={() => { onChange({ ...preferences, widgets: defaultWorkspacePreferences().widgets }); setNotice("Predvolené widgety obnovené. Rozloženie pracoviska a obsah zostali zachované."); }}><RotateCcw size={14} />Obnoviť predvolené widgety</button>
      </section>}
      <p className="sr-only" role="status">{notice}</p>
      {widgets.every(widget => !widget.visible) && <p className="p-4 text-sm text-zinc-500">Vyberte si nástroje cez nastavenie widgetov.</p>}
      {widgets.map(widget => <section key={widget.id} hidden={!widget.visible} data-widget={widget.id} data-collapsed={widget.collapsed} className="border-b border-zinc-200">
        <button type="button" aria-expanded={!widget.collapsed} className="widget-section-toggle flex w-full items-center justify-between gap-2 px-3 text-left text-xs font-semibold hover:bg-zinc-50" onClick={() => onChange({ ...preferences, widgets: preferences.widgets.map(item => item.id === widget.id ? { ...item, collapsed: !item.collapsed } : item) })}>
          <span className="widget-section-title"><WidgetIcon id={widget.id} />{WIDGET_LABELS[widget.id]}</span>{widget.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <div hidden={widget.collapsed}>{renderWidget(widget.id, active && widget.visible && !widget.collapsed)}</div>
      </section>)}
      <button type="button" className="widget-add-tool widget-modern-only" onClick={() => { onSettingsChange(true); scrollRef.current?.scrollTo({ top: 0 }); }}><Plus size={16} />Prispôsobiť nástroje</button>
    </div>
  </aside>;
}
