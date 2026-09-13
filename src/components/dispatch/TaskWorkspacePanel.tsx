"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ClipboardCheck, Filter, ListTodo, Plus, RefreshCw, Search, UserRoundCheck } from "lucide-react";
import type { DispatchCase, Operator } from "@/domain/types";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { isTaskDueToday, isTaskHandoverRelevant, isTaskOverdue, taskPriorityLabels } from "@/domain/tasks";
import { canReviewTask, taskWorkflowLabels, taskWorkflowState, type TaskWorkflowAction } from "@/domain/task-workflow";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import { taskDraft, type TaskDraft, type TaskBoardMutation } from "./task-workspace-store";
import { TaskChatPanel } from "./TaskChatPanel";
import { groupTaskBoard, taskBoardColumn, taskBoardColumns, taskBoardDrop, type TaskBoardColumnId, type TaskBoardDateColumn } from "./task-workspace-board";
import { TaskWorkspaceBoard, TaskWorkspaceCard } from "./TaskWorkspaceBoard";
import { TaskBoardMoveDialog } from "./TaskBoardMoveDialog";
import { TaskWorkflowBoard } from "./TaskWorkflowBoard";
import { TaskReviewDialog } from "./TaskReviewDialog";
import { groupWorkflowBoard, taskWorkflowCardActions, workflowActionLabels } from "./task-workflow-board";
import styles from "./TaskWorkspacePanel.module.css";
export function TaskWorkspacePanel({ tasks, cases, operators, viewerProfileId, variant = "sidebar", compact = false, onOpenCase }: {
  tasks?: WorkspaceTask[]; cases: DispatchCase[]; operators: Operator[]; viewerProfileId?: string;
  variant?: "page" | "sidebar"; compact?: boolean; onOpenCase?: (caseId: string) => void;
}) {
  const { store, snapshot } = useTaskWorkspace();
  const [filter, setFilter] = useState(variant === "page" ? "all" : "team");
  const [assignee, setAssignee] = useState("all");
  const [search, setSearch] = useState("");
  const [audience, setAudience] = useState("all");
  const [workflowScope, setWorkflowScope] = useState("active");
  const [dateFilter, setDateFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [linkCaseId, setLinkCaseId] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [statusTaskId, setStatusTaskId] = useState<string | null>(null);
  const [dateMove, setDateMove] = useState<{ task: WorkspaceTask; column: TaskBoardDateColumn; suggestedDueAt: string } | null>(null);
  const [reviewDialog, setReviewDialog] = useState<{ taskId: string; action: "submit_review" | "return"; revision: number } | null>(null);
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
  const workflowEnabled = snapshot.workflowEnabled;
  const compactWorkflow = workflowEnabled && (compact || variant === "sidebar");
  const activeFilterCount = Number(Boolean(search.trim())) + Number(assignee !== "all") + Number(workflowScope !== "active") + Number(dateFilter !== "all");
  const reviewsForMe = snapshot.tasks.filter(task => canReviewTask(task, viewerProfileId)).length;
  const query = search.trim().toLocaleLowerCase("sk-SK");
  const visible = snapshot.tasks.filter(task => {
    if (assignee !== "all" && task.assignedTo !== assignee) return false;
    if (query && ![task.title, ...task.caseLinks.map(link => link.caseNumber)].some(value => value.toLocaleLowerCase("sk-SK").includes(query))) return false;
    if (workflowEnabled) {
      const stage = taskWorkflowState(task);
      if (workflowScope === "active" && stage === "done") return false;
      if (workflowScope === "done" && stage !== "done") return false;
      if (audience === "mine" && task.assignedTo !== viewerProfileId) return false;
      if (audience === "review" && !canReviewTask(task, viewerProfileId)) return false;
      if (dateFilter === "today") return isTaskDueToday(task, now);
      if (dateFilter === "overdue") return isTaskOverdue(task, now);
      if (dateFilter === "handover") return isTaskHandoverRelevant(task, now);
      if (dateFilter === "undated") return !task.dueAt;
      return true;
    }
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
  const workflowColumns = groupWorkflowBoard(visible, now);
  const navigationColumns = workflowEnabled ? workflowColumns : columns;
  function focusTask(id: string, handle = true) {
    const card = panelRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    const target = card?.querySelector<HTMLButtonElement>(handle ? "[data-task-drag-handle]" : "[data-task-status-action]");
    if (target && !target.disabled) target.focus();
    else (boardRef.current ?? panelRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Obnoviť úlohy"]'))?.focus();
  }
  async function changeTask(task: WorkspaceTask, patch: TaskBoardMutation) {
    const focusSource = document.activeElement as HTMLElement | null;
    const restoreFocus = focusSource?.closest("[data-task-id]")?.getAttribute("data-task-id") === task.id;
    const focusHandle = focusSource?.hasAttribute("data-task-drag-handle");
    setStatusNotice(""); setStatusTaskId(task.id);
    try {
      const saved = await store.moveTask(task.id, patch, task.revision);
      if (saved) {
        const current = store.getSnapshot().tasks.find(item => item.id === task.id);
        const column = current && taskBoardColumns.find(item => item.id === taskBoardColumn(current, new Date()));
        if (current) {
          const superseded = (current.status === "done" ? "done" : "open") !== patch.status ||
            (patch.dueAt !== undefined && (patch.dueAt === null ? Boolean(current.dueAt) : Date.parse(current.dueAt) !== Date.parse(patch.dueAt)));
          setStatusNotice(superseded
            ? `Úloha „${current.title}“ sa medzitým znova zmenila. Aktuálny stĺpec: ${column?.label ?? ""}.`
            : patch.dueAt !== undefined
              ? `Úloha „${current.title}“ bola presunutá. Stĺpec: ${column?.label ?? ""}. ${current.dueAt ? `Termín: ${new Date(current.dueAt).toLocaleString("sk-SK")}.` : "Termín bol odstránený."}`
              : `Úloha „${current.title}“ ${patch.status === "done" ? "bola vybavená" : "bola znova otvorená"}.${column ? ` Stĺpec: ${column.label}.` : ""} Termín zostal zachovaný.`);
        }
      }
      return saved;
    } finally {
      setStatusTaskId(null);
      // A saved card remounts in another column. Restore its keyboard focus
      // only if the user has not moved on to another control while saving.
      if (restoreFocus) window.requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== focusSource) return;
        focusTask(task.id, focusHandle);
      });
    }
  }
  const changeStatus = (task: WorkspaceTask, status: "open" | "done") => changeTask(task, { status });
  async function changeWorkflow(task: WorkspaceTask, action: TaskWorkflowAction, details: { reviewerProfileId?: string; comment?: string } = {}, expectedRevision = task.revision) {
    const focusSource = document.activeElement;
    const focusHandle = focusSource?.hasAttribute("data-task-drag-handle") ?? false;
    setStatusNotice(""); setStatusTaskId(task.id);
    try {
      const saved = await store.workflow(task.id, action, details, expectedRevision);
      if (saved) {
        const current = store.getSnapshot().tasks.find(item => item.id === task.id);
        if (current) setStatusNotice(`Úloha „${current.title}“: ${taskWorkflowLabels[taskWorkflowState(current)]}. Termín a pripomienka zostali zachované.`);
        setReviewDialog(null);
        window.requestAnimationFrame(() => { if (document.activeElement === document.body || document.activeElement === focusSource) focusTask(task.id, focusHandle); });
      }
      return saved;
    } finally { setStatusTaskId(null); }
  }
  function workflowAction(task: WorkspaceTask, action: TaskWorkflowAction) {
    if (snapshot.saving || snapshot.drafts[task.id] || snapshot.conflicts.includes(task.id) || snapshot.pendingWorkflow[task.id]) return;
    if (action === "submit_review" || action === "return") { setStatusNotice(""); setReviewDialog({ taskId: task.id, action, revision: task.revision }); }
    else void changeWorkflow(task, action);
  }
  function closeReviewDialog() {
    const id = reviewDialog?.taskId;
    setReviewDialog(null);
    if (id) window.requestAnimationFrame(() => focusTask(id, false));
  }
  function moveTask(task: WorkspaceTask, column: TaskBoardColumnId) {
    const current = store.getSnapshot();
    if (current.hidden || current.saving || current.drafts[task.id] || current.conflicts.includes(task.id) || !current.tasks.some(item => item.id === task.id)) return;
    const drop = taskBoardDrop(task, column, new Date());
    if (!drop) return;
    setStatusNotice("");
    if (drop.kind === "date") setDateMove({ task, column: drop.column, suggestedDueAt: drop.suggestedDueAt });
    else void changeTask(task, drop.patch);
  }
  function cancelDateMove() {
    const id = dateMove?.task.id;
    setDateMove(null);
    if (id) window.requestAnimationFrame(() => focusTask(id));
  }
  async function confirmDateMove(patch: TaskBoardMutation) {
    if (!dateMove) return;
    const task = dateMove.task;
    const saved = await changeTask(task, patch);
    const current = store.getSnapshot();
    const canonical = current.tasks.find(item => item.id === task.id);
    const alreadyApplied = !current.hidden && !current.saving && !current.drafts[task.id] && !current.conflicts.includes(task.id) &&
      canonical?.status === patch.status && typeof patch.dueAt === "string" && Date.parse(canonical.dueAt) === Date.parse(patch.dueAt);
    if (saved || alreadyApplied) {
      if (!saved) setStatusNotice(`Úloha „${canonical!.title}“ už má zvolený termín.`);
      cancelDateMove();
    }
    else if (current.hidden || !current.tasks.some(item => item.id === task.id) || current.conflicts.includes(task.id)) {
      setDateMove(null);
      // The existing conflict editor provides the reload action.
      window.requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    }
  }
  const cardProps = (task: WorkspaceTask) => ({ task, operators, now, selected: selected?.id === task.id,
    dirty: Boolean(snapshot.drafts[task.id]), disabled: snapshot.saving || Boolean(snapshot.drafts[task.id]) || snapshot.conflicts.includes(task.id) || Boolean(snapshot.pendingWorkflow[task.id]),
    saving: snapshot.saving && statusTaskId === task.id, onSelect: store.select, onStatusChange: changeStatus,
    workflowEnabled, viewerProfileId, onWorkflowAction: workflowAction });
  if (snapshot.hidden) return <section className={styles.panel} aria-label="Pracovný priestor úloh"><p>Overujem prístup k úlohám…</p>{snapshot.error && <p role="alert">{snapshot.error}</p>}<button type="button" onClick={() => void store.reauthorize()}>Overiť prístup znova</button></section>;
  return <section ref={panelRef} className={`${styles.panel} ${variant === "page" ? styles.page : styles.sidebar} ${workflowEnabled ? styles.workflowPanel : ""} ${compactWorkflow ? styles.compactWorkflow : ""}`} aria-label={variant === "sidebar" ? "Widget úloh" : "Pracovný priestor úloh"} style={{ containerType: "inline-size" }}>
    <header className={styles.header}>
      <div className={styles.heading}>{workflowEnabled && <span className={styles.headingIcon}><ListTodo size={19} aria-hidden="true" /></span>}<div>{!(compactWorkflow && variant === "sidebar") && <h2>Úlohy</h2>}<span>{snapshot.tasks.filter(task => task.status !== "done").length} otvorených{workflowEnabled && reviewsForMe > 0 && !compactWorkflow ? ` · ${reviewsForMe} na vašu kontrolu` : ""}</span></div></div>
      <div className={styles.actions}><button type="button" className={styles.refresh} aria-label="Obnoviť úlohy" title="Obnoviť úlohy" disabled={snapshot.loading} onClick={() => void store.refresh()}><RefreshCw size={15} aria-hidden="true" /></button>{compactWorkflow && <button type="button" className={styles.filterToggle} aria-label={`Filtre úloh${activeFilterCount ? ` · ${activeFilterCount} aktívne` : ""}`} aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen(open => !open)}><Filter size={14} aria-hidden="true" />Filtre{activeFilterCount > 0 && <span>{activeFilterCount}</span>}</button>}<button type="button" aria-label="Nová úloha" className={styles.primary} onClick={store.openCreate}><Plus size={15} aria-hidden="true" />{compactWorkflow && variant === "sidebar" ? "Nová" : "Nová úloha"}</button></div>
    </header>
    {snapshot.error && <div role="alert" className={styles.error}>{snapshot.error}</div>}
    {!workflowEnabled && !snapshot.loading && <p className={styles.capabilityNotice}>Pracovné stavy a kontrola úloh čakajú na aktiváciu servera. Existujúce úlohy môžete ďalej spravovať.</p>}
    {Object.entries(snapshot.pendingWorkflow).map(([id]) => <div key={id} role="status" className={styles.pendingNotice}>Výsledok zmeny úlohy „{snapshot.tasks.find(task => task.id === id)?.title}“ ešte nie je potvrdený. <button type="button" disabled={snapshot.saving} onClick={() => void store.retryWorkflow(id)}>Overiť pôvodnú zmenu stavu</button></div>)}
    {statusNotice && <p role="status" className={styles.statusNotice}>{statusNotice}</p>}
    {conflict && selected && <div role="alert" className={styles.error}>Úloha sa medzitým zmenila. Váš draft zostáva zachovaný.<button type="button" onClick={() => void store.reloadTask(selected.id)}>Načítať aktuálnu úlohu a nahradiť draft</button></div>}
    <div className={`${styles.workspaceBody} ${editing ? styles.withEditor : ""}`}>
      <div className={styles.overview}>
        {workflowEnabled && <nav className={styles.audienceTabs} aria-label="Zodpovednosť za úlohy">
          <button type="button" aria-label="Všetky tímové" aria-pressed={audience === "all"} onClick={() => setAudience("all")}>{compactWorkflow ? "Všetky" : "Všetky tímové"}</button>
          <button type="button" aria-label="Moje úlohy" aria-pressed={audience === "mine"} onClick={() => setAudience("mine")}>{compactWorkflow ? "Moje" : "Moje úlohy"}</button>
          <button type="button" aria-label={`Na moju kontrolu ${reviewsForMe}`} aria-pressed={audience === "review"} onClick={() => { setAudience("review"); setWorkflowScope("active"); }}><ClipboardCheck size={14} aria-hidden="true" />{compactWorkflow ? "Kontrola" : "Na moju kontrolu"}<span>{reviewsForMe}</span></button>
        </nav>}
        <div id={filtersId} hidden={compactWorkflow && !filtersOpen} className={styles.filters}>
          {variant === "page" && <label className={styles.search}><span>Hľadať úlohy</span><div><Search size={15} aria-hidden="true" /><input type="search" placeholder="Názov alebo číslo prípadu" value={search} onChange={event => setSearch(event.target.value)} /></div></label>}
          {workflowEnabled ? <><label>Zobraziť úlohy<select value={workflowScope} onChange={event => setWorkflowScope(event.target.value)}><option value="active">Aktívne úlohy</option><option value="done">Vybavené úlohy</option><option value="all">Všetky stavy</option></select></label><label>Termín<select value={dateFilter} onChange={event => setDateFilter(event.target.value)}><option value="all">Všetky termíny</option><option value="today">Dnes</option><option value="overdue">Po termíne</option><option value="undated">Bez termínu</option><option value="handover">Na odovzdanie služby</option></select></label></> : <label>Zobraziť úlohy<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Všetky úlohy</option><option value="team">Otvorené</option><option value="mine">Moje</option><option value="today">Dnes</option><option value="overdue">Po termíne</option><option value="handover">Odovzdanie</option><option value="done">Vybavené</option></select></label>}
          <label>Operátor<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">Všetci operátori</option><option value="unassigned">Nepriradené</option>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
          <span className={styles.resultCount} role="status">{visible.length} úloh</span>
        </div>
        {variant === "page" && <nav className={styles.columnNavigation} aria-label="Stĺpce úloh">{navigationColumns.map(column => <button key={column.id} type="button" onClick={() => {
          const target = boardRef.current?.querySelector<HTMLElement>(`[data-task-column="${column.id}"]`);
          if (target) boardRef.current?.scrollTo({ left: target.offsetLeft - 12 });
        }}>{column.label}<span>{column.tasks.length}</span></button>)}</nav>}
        {variant === "page" ? <>
          {workflowEnabled ? <><p className={styles.boardHelp}>Presuňte úlohu podľa priebehu práce. Termín zostáva samostatný; kontrolu potvrdzuje vybraný kolega.</p><TaskWorkflowBoard columns={workflowColumns} boardRef={boardRef} cardProps={cardProps} viewerProfileId={viewerProfileId} loading={snapshot.loading} onAction={workflowAction} /></> : <><p className={styles.boardHelp}>Potiahnite úlohu do cieľového stĺpca. Dnes nastaví termín do konca dňa, Bez termínu ho odstráni. Naplánované a Po termíne ponúknu výber dátumu. Samostatná pripomienka sa nemení.</p><TaskWorkspaceBoard columns={columns} boardRef={boardRef} loading={snapshot.loading} filtered={filter !== "all" || assignee !== "all" || Boolean(query)} now={now} cardProps={cardProps} onMove={moveTask} /></>}
        </> : <div className={styles.sidebarList}><ul className={styles.list}>{visible.map(task => <TaskWorkspaceCard key={task.id} {...cardProps(task)} />)}</ul>{!snapshot.loading && visible.length === 0 && <p className={styles.emptyColumn}>Žiadne úlohy v tomto pohľade.</p>}</div>}
      </div>
      {editing && <aside className={styles.editor} aria-label={selected ? "Detail úlohy" : "Nová úloha"}>
      <header className={styles.editorHeader}><h3>{selected ? "Detail úlohy" : "Nová úloha"}</h3><button type="button" onClick={() => store.select(null)}><ArrowLeft size={14} aria-hidden="true" />Späť na úlohy</button></header>
      {selected && workflowEnabled && <section className={styles.workflowSummary} aria-label="Priebeh a kontrola úlohy">
        <div className={styles.workflowSummaryHeading}><span className={`${styles.stageBadge} ${styles[taskWorkflowState(selected)]}`}>{taskWorkflowLabels[taskWorkflowState(selected)]}</span>{selected.reviewGeneration ? <span>Kontrola {selected.reviewGeneration}</span> : null}</div>
        {selected.reviewerProfileId && <p className={styles.reviewerLine}><UserRoundCheck size={16} aria-hidden="true" />Kontrolór: <strong>{operators.find(operator => operator.id === selected.reviewerProfileId)?.name ?? "Určený kolega"}</strong></p>}
        {selected.reviewSubmission && <div className={styles.reviewText}><strong>Odovzdaný výsledok</strong><p>{selected.reviewSubmission}</p></div>}
        {selected.reviewReturnReason && <div className={`${styles.reviewText} ${styles.reviewReturned}`}><strong>Dôvod vrátenia</strong><p>{selected.reviewReturnReason}</p></div>}
        {selected.reviewedAt && <p className={styles.reviewCompleted}>Schválil(a) {operators.find(operator => operator.id === selected.reviewedBy)?.name ?? "kontrolór"} · {new Date(selected.reviewedAt).toLocaleString("sk-SK")}</p>}
        <div className={styles.workflowDetailActions}>{taskWorkflowCardActions(selected, viewerProfileId).map(action => <button type="button" key={action} className={action === "approve" || action === "submit_review" ? styles.workflowPrimary : ""} disabled={cardProps(selected).disabled} onClick={() => workflowAction(selected, action)}>{workflowActionLabels[action]}</button>)}
          {taskWorkflowState(selected) === "todo" && !selected.reviewerProfileId && <button type="button" disabled={cardProps(selected).disabled} onClick={() => workflowAction(selected, "submit_review")}>Poslať na kontrolu</button>}
          {taskWorkflowState(selected) === "in_progress" && <button type="button" disabled={cardProps(selected).disabled} onClick={() => workflowAction(selected, "to_todo")}>Na vybavenie</button>}
          {taskWorkflowState(selected) === "in_review" && (selected.reviewRequestedBy === viewerProfileId || selected.assignedTo === viewerProfileId) && <button type="button" disabled={cardProps(selected).disabled} onClick={() => workflowAction(selected, "submit_review")}>Zmeniť kontrolóra</button>}
        </div>{snapshot.drafts[selected.id] && <small>Pred zmenou stavu uložte rozpísané údaje nižšie.</small>}
      </section>}
      <section className={styles.section} aria-label="Editor úlohy">
        <label>Názov úlohy<textarea ref={titleRef} value={draft.title} maxLength={500} onChange={event => change({ title: event.target.value })} rows={2} /></label>
        <div className={styles.grid}>
          <label>Zodpovedná osoba<select value={draft.assignedTo} onChange={event => change({ assignedTo: event.target.value })}><option value="unassigned">Nepriradené</option>{operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
          <label>Termín úlohy<input type="datetime-local" value={localTime(draft.dueAt)} onChange={event => change({ dueAt: event.target.value })} /></label>
          <label>Pripomenúť o<input type="datetime-local" value={localTime(draft.reminderAt)} onChange={event => change({ reminderAt: event.target.value })} /><span>Bez samostatného času sa použije termín úlohy.</span></label>
          <label>Priorita úlohy<select value={draft.priority} onChange={event => change({ priority: event.target.value as TaskDraft["priority"] })}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {selected && !workflowEnabled && <label>Stav úlohy<select value={draft.status} onChange={event => change({ status: event.target.value as TaskDraft["status"] })}><option value="open">Otvorená</option><option value="done">Vybavená</option></select></label>}
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
    {dateMove && snapshot.tasks.some(task => task.id === dateMove.task.id) && <TaskBoardMoveDialog
      key={`${dateMove.task.id}:${dateMove.column}`} title={dateMove.task.title} column={dateMove.column} suggestedDueAt={dateMove.suggestedDueAt}
      saving={snapshot.saving} error={snapshot.error} onCancel={cancelDateMove} onConfirm={patch => void confirmDateMove(patch)} />}
    {reviewDialog && snapshot.tasks.some(task => task.id === reviewDialog.taskId) && <TaskReviewDialog key={`${reviewDialog.taskId}:${reviewDialog.action}`} task={snapshot.tasks.find(task => task.id === reviewDialog.taskId)!} action={reviewDialog.action} operators={operators} viewerProfileId={viewerProfileId}
      saving={snapshot.saving} pending={snapshot.pendingWorkflow[reviewDialog.taskId]} error={snapshot.error} onCancel={closeReviewDialog} onConfirm={details => void changeWorkflow(snapshot.tasks.find(task => task.id === reviewDialog.taskId)!, reviewDialog.action, details, reviewDialog.revision)} />}
  </section>;
}
function localTime(value: string) { if (!value) return ""; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16) : value; }
