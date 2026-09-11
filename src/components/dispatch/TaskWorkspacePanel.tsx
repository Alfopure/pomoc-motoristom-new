"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Search } from "lucide-react";
import type { DispatchCase, Operator } from "@/domain/types";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { isTaskDueToday, isTaskHandoverRelevant, isTaskOverdue, taskPriorityLabels } from "@/domain/tasks";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import { taskDraft, type TaskDraft } from "./task-workspace-store";
import { TaskChatPanel } from "./TaskChatPanel";
import { groupTaskBoard, taskBoardColumn, taskBoardColumns } from "./task-workspace-board";
import { TaskWorkspaceBoard, TaskWorkspaceCard } from "./TaskWorkspaceBoard";
import styles from "./TaskWorkspacePanel.module.css";
export function TaskWorkspacePanel({ tasks, cases, operators, viewerProfileId, variant = "sidebar", onOpenCase }: {
  tasks?: WorkspaceTask[]; cases: DispatchCase[]; operators: Operator[]; viewerProfileId?: string;
  variant?: "page" | "sidebar"; onOpenCase?: (caseId: string) => void;
}) {
  const { store, snapshot } = useTaskWorkspace();
  const [filter, setFilter] = useState(variant === "page" ? "all" : "team");
  const [assignee, setAssignee] = useState("all");
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [linkCaseId, setLinkCaseId] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [statusTaskId, setStatusTaskId] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  useEffect(() => { if (tasks) store.setTasks(tasks); }, [store, tasks]);
  useEffect(() => {
    if (snapshot.selectedId || snapshot.creating) titleRef.current?.focus({ preventScroll: true });
  }, [snapshot.selectedId, snapshot.creating]);
  const selected = snapshot.tasks.find(task => task.id === snapshot.selectedId);
  const draft = selected ? snapshot.drafts[selected.id]?.value ?? taskDraft(selected) : snapshot.createDraft;
  const now = new Date();
  const query = search.trim().toLocaleLowerCase("sk-SK");
  const visible = snapshot.tasks.filter(task => {
    if (assignee !== "all" && task.assignedTo !== assignee) return false;
    if (query && ![task.title, ...task.caseLinks.map(link => link.caseNumber)].some(value => value.toLocaleLowerCase("sk-SK").includes(query))) return false;
    if (filter === "all") return true;
    if (filter === "done") return task.status === "done";
    if (task.status === "done") return false;
    if (filter === "mine") return task.assignedTo === viewerProfileId;
    if (filter === "today") return isTaskDueToday(task, now);
    if (filter === "overdue") return isTaskOverdue(task, now);
    if (filter === "handover") return isTaskHandoverRelevant(task, now);
    return true;
  });
  const editing = Boolean(selected || snapshot.creating);
  const change = (patch: Partial<TaskDraft>) => selected ? store.edit(selected.id, patch) : store.editCreate(patch);
  const conflict = Boolean(selected && snapshot.conflicts.includes(selected.id));
  const columns = groupTaskBoard(visible, now);
  async function changeStatus(task: WorkspaceTask, status: "open" | "done") {
    const focusSource = document.activeElement as HTMLElement | null;
    const restoreFocus = focusSource?.closest("[data-task-id]")?.getAttribute("data-task-id") === task.id;
    const focusHandle = focusSource?.hasAttribute("data-task-drag-handle");
    setStatusNotice(""); setStatusTaskId(task.id);
    try {
      const saved = await store.setTaskStatus(task.id, status, task.revision);
      if (saved) {
        const current = store.getSnapshot().tasks.find(item => item.id === task.id);
        const column = current && taskBoardColumns.find(item => item.id === taskBoardColumn(current, new Date()));
        if (current) {
          const superseded = (current.status === "done" ? "done" : "open") !== status;
          setStatusNotice(superseded
            ? `Úloha „${current.title}“ sa medzitým znova zmenila. Aktuálny stĺpec: ${column?.label ?? ""}.`
            : `Úloha „${current.title}“ ${status === "done" ? "bola vybavená" : "bola znova otvorená"}.${column ? ` Stĺpec: ${column.label}.` : ""} Termín zostal zachovaný.`);
        }
      }
    } finally {
      setStatusTaskId(null);
      // A saved card remounts in another column. Restore its keyboard focus
      // only if the user has not moved on to another control while saving.
      if (restoreFocus) window.requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== focusSource) return;
        const card = panelRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(task.id)}"]`);
        const target = card?.querySelector<HTMLButtonElement>(focusHandle ? "[data-task-drag-handle]" : "[data-task-status-action]");
        if (target && !target.disabled) target.focus();
        else (boardRef.current ?? panelRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Obnoviť úlohy"]'))?.focus();
      });
    }
  }
  const cardProps = (task: WorkspaceTask) => ({ task, operators, now, selected: selected?.id === task.id,
    dirty: Boolean(snapshot.drafts[task.id]), disabled: snapshot.saving || Boolean(snapshot.drafts[task.id]) || snapshot.conflicts.includes(task.id),
    saving: snapshot.saving && statusTaskId === task.id, onSelect: store.select, onStatusChange: changeStatus });
  if (snapshot.hidden) return <section className={styles.panel} aria-label="Pracovný priestor úloh"><p>Overujem prístup k úlohám…</p>{snapshot.error && <p role="alert">{snapshot.error}</p>}<button type="button" onClick={() => void store.reauthorize()}>Overiť prístup znova</button></section>;
  return <section ref={panelRef} className={`${styles.panel} ${variant === "page" ? styles.page : styles.sidebar}`} aria-label={variant === "sidebar" ? "Widget úloh" : "Pracovný priestor úloh"} style={{ containerType: "inline-size" }}>
    <header className={styles.header}>
      <div className={styles.heading}><h2>Úlohy</h2><span>{snapshot.tasks.filter(task => task.status !== "done").length} otvorených</span></div>
      <div className={styles.actions}><button type="button" className={styles.refresh} aria-label="Obnoviť úlohy" title="Obnoviť úlohy" disabled={snapshot.loading} onClick={() => void store.refresh()}><RefreshCw size={15} aria-hidden="true" /></button><button type="button" className={styles.primary} onClick={store.openCreate}><Plus size={15} aria-hidden="true" />Nová úloha</button></div>
    </header>
    {snapshot.error && <div role="alert" className={styles.error}>{snapshot.error}</div>}
    {statusNotice && <p role="status" className={styles.statusNotice}>{statusNotice}</p>}
    {conflict && selected && <div role="alert" className={styles.error}>Úloha sa medzitým zmenila. Váš draft zostáva zachovaný.<button type="button" onClick={() => void store.reloadTask(selected.id)}>Načítať aktuálnu úlohu a nahradiť draft</button></div>}
    <div className={`${styles.workspaceBody} ${editing ? styles.withEditor : ""}`}>
      <div className={styles.overview}>
        <div className={styles.filters}>
          {variant === "page" && <label className={styles.search}><span>Hľadať úlohy</span><div><Search size={15} aria-hidden="true" /><input type="search" placeholder="Názov alebo číslo prípadu" value={search} onChange={event => setSearch(event.target.value)} /></div></label>}
          <label>Zobraziť úlohy<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Všetky úlohy</option><option value="team">Otvorené</option><option value="mine">Moje</option><option value="today">Dnes</option><option value="overdue">Po termíne</option><option value="handover">Odovzdanie</option><option value="done">Vybavené</option></select></label>
          <label>Operátor<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">Všetci operátori</option><option value="unassigned">Nepriradené</option>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
          <span className={styles.resultCount} role="status">{visible.length} úloh</span>
        </div>
        {variant === "page" && <nav className={styles.columnNavigation} aria-label="Stĺpce úloh">{columns.map(column => <button key={column.id} type="button" onClick={() => {
          const target = boardRef.current?.querySelector<HTMLElement>(`[data-task-column="${column.id}"]`);
          if (target) boardRef.current?.scrollTo({ left: target.offsetLeft - 12 });
        }}>{column.label}<span>{column.tasks.length}</span></button>)}</nav>}
        {variant === "page" ? <>
          <p className={styles.boardHelp}>Potiahnite úlohu do Vybavené alebo späť na otvorenie. Termín sa nemení.</p>
          <TaskWorkspaceBoard columns={columns} boardRef={boardRef} loading={snapshot.loading} filtered={filter !== "all" || assignee !== "all" || Boolean(query)} cardProps={cardProps} onStatusChange={changeStatus} />
        </> : <div className={styles.sidebarList}><ul className={styles.list}>{visible.map(task => <TaskWorkspaceCard key={task.id} {...cardProps(task)} />)}</ul>{!snapshot.loading && visible.length === 0 && <p className={styles.emptyColumn}>Žiadne úlohy v tomto pohľade.</p>}</div>}
      </div>
      {editing && <aside className={styles.editor} aria-label={selected ? "Detail úlohy" : "Nová úloha"}>
      <header className={styles.editorHeader}><h3>{selected ? "Detail úlohy" : "Nová úloha"}</h3><button type="button" onClick={() => store.select(null)}><ArrowLeft size={14} aria-hidden="true" />Späť na úlohy</button></header>
      <section className={styles.section} aria-label="Editor úlohy">
        <label>Názov úlohy<textarea ref={titleRef} value={draft.title} maxLength={500} onChange={event => change({ title: event.target.value })} rows={2} /></label>
        <div className={styles.grid}>
          <label>Zodpovedná osoba<select value={draft.assignedTo} onChange={event => change({ assignedTo: event.target.value })}><option value="unassigned">Nepriradené</option>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
          <label>Termín úlohy<input type="datetime-local" value={localTime(draft.dueAt)} onChange={event => change({ dueAt: event.target.value })} /></label>
          <label>Pripomenúť o<input type="datetime-local" value={localTime(draft.reminderAt)} onChange={event => change({ reminderAt: event.target.value })} /><span>Bez samostatného času sa použije termín úlohy.</span></label>
          <label>Priorita úlohy<select value={draft.priority} onChange={event => change({ priority: event.target.value as TaskDraft["priority"] })}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {selected && <label>Stav úlohy<select value={draft.status} onChange={event => change({ status: event.target.value as TaskDraft["status"] })}><option value="open">Otvorená</option><option value="done">Vybavená</option></select></label>}
        </div>
        {!selected && <>
          <fieldset className={styles.caseChoices}><legend>Pripojené prípady · {draft.caseIds.length} (voliteľné)</legend><p>Bez výberu vznikne samostatná úloha.</p>{cases.map(item => <label key={item.id} className={styles.caseChoice}><input type="checkbox" checked={draft.caseIds.includes(item.id)} onChange={event => change({ caseIds: event.target.checked ? [...draft.caseIds, item.id] : draft.caseIds.filter(id => id !== item.id) })} />{item.caseNumber} · {item.contact.name}</label>)}</fieldset>
          <label className={styles.caseChoice}><input type="checkbox" checked={draft.reminderChannels.includes("email")} onChange={event => change({ reminderChannels: event.target.checked ? ["in_app", "email"] : ["in_app"] })} />Pripomienka aj emailom</label>
        </>}
        <div className={styles.row}><button type="button" className={styles.primary} disabled={snapshot.saving || conflict || !draft.title.trim() || (Boolean(selected) && !snapshot.drafts[selected!.id])} onClick={() => void (selected ? store.saveTask(selected.id) : store.create())}>{snapshot.saving ? "Ukladám…" : selected ? "Uložiť úlohu" : "Vytvoriť úlohu"}</button>{selected && <button type="button" className={styles.danger} disabled={snapshot.saving} onClick={() => setDeleteId(selected.id)}>Vymazať celú úlohu</button>}</div>
      </section>
      {selected && <>
        <section aria-label="Prípady úlohy" className={styles.section}><h3>Pripojené prípady ({selected.caseLinks.length})</h3>{selected.caseLinks.length === 0 && <p>Samostatná úloha bez prípadu.</p>}
          <div className={styles.links}>{selected.caseLinks.map(link => <div key={link.caseId} className={styles.row}>{onOpenCase ? <button type="button" onClick={() => onOpenCase(link.caseId)}>{link.caseNumber}</button> : <span>{link.caseNumber}</span>}<button type="button" disabled={snapshot.saving || Boolean(snapshot.drafts[selected.id]) || (selected.originLocked && selected.caseId === link.caseId)} onClick={() => void store.link(selected.id, link.caseId, true)}>{selected.originLocked && selected.caseId === link.caseId ? "Pôvodná väzba je povinná" : "Odpojiť tento prípad"}</button></div>)}</div>
          <label>Pripojiť ďalší prípad<select value={linkCaseId} onChange={event => setLinkCaseId(event.target.value)}><option value="">Vyberte prípad</option>{cases.filter(item => !selected.caseIds.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.caseNumber} · {item.contact.name}</option>)}</select></label>
          <button type="button" disabled={!linkCaseId || snapshot.saving || Boolean(snapshot.drafts[selected.id])} onClick={() => { void store.link(selected.id, linkCaseId).then(saved => { if (saved) setLinkCaseId(""); }); }}>Pripojiť prípad</button>
          {snapshot.drafts[selected.id] && <p>Pred pripojením alebo odpojením prípadu uložte rozpracovanú úlohu.</p>}
        </section>
        {deleteId === selected.id && <section className={styles.error} role="alert" aria-label="Potvrdenie vymazania celej úlohy"><p>Vymazať úlohu „{selected.title}“ zo všetkých {selected.caseLinks.length} prípadov aj so správami? Na odstránenie jednej väzby použite Odpojiť tento prípad.</p><div className={styles.row}><button type="button" disabled={snapshot.saving} onClick={() => setDeleteId(null)}>Zrušiť</button><button type="button" disabled={snapshot.saving} onClick={() => void store.deleteTask(selected.id).then(deleted => { if (deleted) setDeleteId(null); })}>Potvrdiť vymazanie celej úlohy</button></div></section>}
        <TaskChatPanel taskId={selected.id} />
      </>}
      </aside>}
    </div>
  </section>;
}
function localTime(value: string) { if (!value) return ""; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16) : value; }
