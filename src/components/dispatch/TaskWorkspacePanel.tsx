"use client";
import { useEffect, useState } from "react";
import type { DispatchCase, Operator } from "@/domain/types";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { isTaskDueToday, isTaskHandoverRelevant, isTaskOverdue, taskPriorityLabels } from "@/domain/tasks";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import { taskDraft, type TaskDraft } from "./task-workspace-store";
import { TaskChatPanel } from "./TaskChatPanel";
import styles from "./TaskWorkspacePanel.module.css";
export function TaskWorkspacePanel({ tasks, cases, operators, viewerProfileId, variant = "sidebar", onOpenCase }: {
  tasks?: WorkspaceTask[]; cases: DispatchCase[]; operators: Operator[]; viewerProfileId?: string;
  variant?: "page" | "sidebar"; onOpenCase?: (caseId: string) => void;
}) {
  const { store, snapshot } = useTaskWorkspace();
  const [filter, setFilter] = useState("team"), [assignee, setAssignee] = useState("all"), [deleteId, setDeleteId] = useState<string | null>(null), [linkCaseId, setLinkCaseId] = useState("");
  useEffect(() => { if (tasks) store.setTasks(tasks); }, [store, tasks]);
  const selected = snapshot.tasks.find(task => task.id === snapshot.selectedId);
  const draft = selected ? snapshot.drafts[selected.id]?.value ?? taskDraft(selected) : snapshot.createDraft;
  const now = new Date();
  const visible = snapshot.tasks.filter(task => {
    if (assignee !== "all" && task.assignedTo !== assignee) return false;
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
  if (snapshot.hidden) return <section className={styles.panel} aria-label="Pracovný priestor úloh"><p>Overujem prístup k úlohám…</p>{snapshot.error && <p role="alert">{snapshot.error}</p>}<button type="button" onClick={() => void store.reauthorize()}>Overiť prístup znova</button></section>;
  return <section className={styles.panel} aria-label={variant === "sidebar" ? "Widget úloh" : "Pracovný priestor úloh"} style={{ containerType: "inline-size" }}>
    <header className={styles.row}><h2>{selected ? "Detail úlohy" : snapshot.creating ? "Nová úloha" : "Zoznam úloh"}</h2><div className={styles.row}>{editing ? <button type="button" onClick={() => store.select(null)}>Späť na úlohy</button> : <button type="button" onClick={store.openCreate}>Nová úloha</button>}<button type="button" disabled={snapshot.loading} onClick={() => void store.refresh()}>Obnoviť úlohy</button></div></header>
    {snapshot.error && <div role="alert" className={styles.error}>{snapshot.error}</div>}
    {conflict && selected && <div role="alert" className={styles.error}>Úloha sa medzitým zmenila. Váš draft zostáva zachovaný.<button type="button" onClick={() => void store.reloadTask(selected.id)}>Načítať aktuálnu úlohu a nahradiť draft</button></div>}
    {editing ? <>
      <section className={styles.section} aria-label="Editor úlohy">
        <label>Názov úlohy<textarea value={draft.title} maxLength={500} onChange={event => change({ title: event.target.value })} rows={3} /></label>
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
        <div className={styles.row}><button type="button" disabled={snapshot.saving || conflict || !draft.title.trim() || (Boolean(selected) && !snapshot.drafts[selected!.id])} onClick={() => void (selected ? store.saveTask(selected.id) : store.create())}>{snapshot.saving ? "Ukladám…" : selected ? "Uložiť úlohu" : "Vytvoriť úlohu"}</button>{selected && <button type="button" className={styles.danger} disabled={snapshot.saving} onClick={() => setDeleteId(selected.id)}>Vymazať celú úlohu</button>}</div>
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
    </> : <>
      <div className={`${styles.section} ${styles.grid}`}><label>Zobraziť úlohy<select value={filter} onChange={event => setFilter(event.target.value)}><option value="team">Otvorené</option><option value="mine">Moje</option><option value="today">Dnes</option><option value="overdue">Po termíne</option><option value="handover">Odovzdanie</option><option value="done">Vybavené</option></select></label><label>Operátor<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">Všetci operátori</option><option value="unassigned">Nepriradené</option>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label></div>
      <ul className={styles.list}>{visible.map(task => <li key={task.id} className={styles.card}><button type="button" className={styles.title} onClick={() => store.select(task.id)}>{task.title}</button><div className={styles.meta}><span>{taskPriorityLabels[task.priority]}</span><span>{task.dueAt ? new Date(task.dueAt).toLocaleString("sk-SK") : "Bez termínu"}</span><span>{operators.find(operator => operator.id === task.assignedTo)?.name ?? "Nepriradené"}</span></div><div className={styles.meta}>{task.caseLinks.length ? task.caseLinks.map(link => <span key={link.caseId}>{link.caseNumber}</span>) : <span>Samostatná úloha</span>}</div></li>)}</ul>
      {!snapshot.loading && visible.length === 0 && <p>Žiadne úlohy v tomto pohľade.</p>}
    </>}
  </section>;
}
function localTime(value: string) { if (!value) return ""; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16) : value; }
