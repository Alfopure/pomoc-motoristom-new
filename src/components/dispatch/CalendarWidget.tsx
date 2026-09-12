"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import { calendarDayKey, calendarMonthDays, calendarTasksByDay } from "./calendar-widget";

const weekdays = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1, 12);

/** A view of the existing authorized task store; no second task cache or API. */
export function CalendarWidget({ onOpenTask }: { onOpenTask: (taskId: string, caseId: string) => void }) {
  const { store, snapshot } = useTaskWorkspace();
  const [today, setToday] = useState(() => new Date());
  const [selected, setSelected] = useState(() => new Date());
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [includeDone, setIncludeDone] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => calendarMonthDays(month), [month]);
  const byDay = useMemo(() => calendarTasksByDay(snapshot.hidden ? [] : snapshot.tasks, includeDone), [snapshot.hidden, snapshot.tasks, includeDone]);
  const selectedKey = calendarDayKey(selected);
  const agenda = byDay.get(selectedKey) ?? [];
  useEffect(() => {
    const timer = window.setInterval(() => { const now = new Date(); setToday(previous => calendarDayKey(previous) === calendarDayKey(now) ? previous : now); }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  function selectDay(day: Date, focus = false) {
    setSelected(day); setMonth(monthStart(day));
    if (focus) requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-calendar-day="${calendarDayKey(day)}"]`)?.focus());
  }
  function keyDay(event: KeyboardEvent<HTMLButtonElement>, day: Date) {
    const next = new Date(day);
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(day.getDay() + 6) % 7, End: 6 - (day.getDay() + 6) % 7 };
    if (event.key in offsets) next.setDate(next.getDate() + offsets[event.key]);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      next.setDate(1); next.setMonth(next.getMonth() + (event.key === "PageUp" ? -1 : 1));
      next.setDate(Math.min(day.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    } else return;
    event.preventDefault(); selectDay(next, true);
  }
  if (!store.enabled) return <p className="p-3 text-sm text-zinc-600">Termíny budú dostupné po aktivácii pracovného priestoru úloh.</p>;
  if (snapshot.hidden) return <p className="p-3 text-sm text-zinc-600" role="status">Overujem prístup k termínom úloh…</p>;
  return <section className="calendar-widget space-y-3 p-3" aria-label="Kalendár úloh">
    <header className="calendar-header flex flex-wrap items-center justify-between gap-1">
      <h3 className="text-sm font-semibold capitalize" aria-live="polite">{month.toLocaleDateString("sk-SK", { month: "long", year: "numeric" })}</h3>
      <div className="flex items-center gap-1">
        <button type="button" className="calendar-control min-h-8 rounded-md px-2 text-xs hover:bg-zinc-100" onClick={() => selectDay(new Date())}>Dnes</button>
        <button type="button" className="calendar-control inline-flex min-h-8 min-w-8 items-center justify-center rounded-md hover:bg-zinc-100" aria-label="Predchádzajúci mesiac" onClick={() => selectDay(new Date(month.getFullYear(), month.getMonth() - 1, 1, 12))}><ChevronLeft size={17} /></button>
        <button type="button" className="calendar-control inline-flex min-h-8 min-w-8 items-center justify-center rounded-md hover:bg-zinc-100" aria-label="Nasledujúci mesiac" onClick={() => selectDay(new Date(month.getFullYear(), month.getMonth() + 1, 1, 12))}><ChevronRight size={17} /></button>
      </div>
    </header>
    <p className="sr-only">Dni vyberiete aj šípkami. Page Up a Page Down menia mesiac.</p>
    <div className="calendar-scroll overflow-x-auto">
      <div className="calendar-days grid grid-cols-7 gap-1" ref={gridRef}>
        {weekdays.map(day => <span key={day} className="py-1 text-center text-[11px] font-medium text-zinc-500" aria-hidden="true">{day}</span>)}
        {days.map(day => {
          const key = calendarDayKey(day), count = byDay.get(key)?.length ?? 0;
          return <button key={key} type="button" data-calendar-day={key} data-current-month={day.getMonth() === month.getMonth()} aria-current={key === calendarDayKey(today) ? "date" : undefined} aria-pressed={key === selectedKey} tabIndex={key === selectedKey ? 0 : -1} aria-label={`${day.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}${count ? `, počet úloh: ${count}` : ""}`} className={`calendar-day flex min-h-8 min-w-0 flex-col items-center justify-center rounded-lg text-xs ${key === selectedKey ? "bg-zinc-900 text-white" : day.getMonth() !== month.getMonth() ? "text-zinc-400" : "text-zinc-800 hover:bg-zinc-100"}`} onClick={() => selectDay(day)} onKeyDown={event => keyDay(event, day)}><span>{day.getDate()}</span><span className={`h-1 w-1 rounded-full ${count ? "bg-amber-500" : "bg-transparent"}`} aria-hidden="true" /></button>;
        })}
      </div>
    </div>
    <label className="calendar-completed flex min-h-8 items-center gap-2 text-xs text-zinc-600"><input type="checkbox" className="h-4 w-4 accent-zinc-900" checked={includeDone} onChange={event => setIncludeDone(event.target.checked)} />Zahrnúť vybavené úlohy</label>
    <div className="calendar-agenda border-t border-zinc-200 pt-2">
      <h4 className="text-xs font-semibold capitalize">{selected.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" })}</h4>
      {snapshot.error && <p className="mt-2 text-xs text-amber-800" role="status">{snapshot.error}</p>}
      {agenda.length ? <ul className="mt-2 space-y-1">{agenda.map(task => <li key={task.id}><button type="button" className="calendar-task w-full rounded-lg border border-zinc-200 p-2 text-left hover:bg-zinc-50" onClick={() => onOpenTask(task.id, task.caseId || task.caseIds[0] || "")}><span className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-600"><time dateTime={task.dueAt}>{new Date(task.dueAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" })}</time><span>{task.status === "done" ? "Vybavená" : "Otvorená"}</span>{task.priority === "urgent" && <span className="text-red-700">Urgentná</span>}</span><strong className="mt-1 block break-words text-xs font-medium">{task.title}</strong>{task.caseLinks.length > 0 && <span className="mt-1 block break-words text-[11px] text-zinc-600">{task.caseLinks.map(link => link.caseNumber).join(" · ")}</span>}</button></li>)}</ul> : <p className="mt-2 text-xs leading-relaxed text-zinc-500">{snapshot.loading ? "Načítavam termíny…" : "Na tento deň nie sú naplánované úlohy."}</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">Termíny sa preberajú z úloh. Úlohy bez termínu nájdete v hlavnom prehľade.</p>
    </div>
  </section>;
}
