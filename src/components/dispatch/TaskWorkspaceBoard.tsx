"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, PointerSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { CalendarDays, CheckCircle2, Clock3, GripVertical, RotateCcw, UserRoundCheck } from "lucide-react";
import type { Operator } from "@/domain/types";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { isTaskOverdue, taskPriorityLabels } from "@/domain/tasks";
import { taskWorkflowLabels, taskWorkflowState, type TaskWorkflowAction } from "@/domain/task-workflow";
import { taskWorkflowCardActions, workflowActionLabels } from "./task-workflow-board";
import { groupTaskBoard, taskBoardDrop, type TaskBoardColumnId } from "./task-workspace-board";
import styles from "./TaskWorkspacePanel.module.css";

export type TaskWorkspaceCardProps = {
  task: WorkspaceTask;
  operators: Operator[];
  selected?: boolean;
  dirty?: boolean;
  disabled: boolean;
  saving?: boolean;
  draggable?: boolean;
  now: Date;
  onSelect: (id: string) => void;
  onStatusChange: (task: WorkspaceTask, status: "open" | "done") => void;
  workflowEnabled?: boolean;
  viewerProfileId?: string;
  onWorkflowAction?: (task: WorkspaceTask, action: TaskWorkflowAction) => void;
};

export function TaskWorkspaceCard({ task, operators, selected, dirty, disabled, saving, draggable = false, now, onSelect, onStatusChange, workflowEnabled, viewerProfileId, onWorkflowAction }: TaskWorkspaceCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: task.id, disabled: !draggable || disabled });
  const operator = operators.find(item => item.id === task.assignedTo);
  const action = task.status === "done" ? "Otvoriť znova" : "Vybaviť";
  const stage = taskWorkflowState(task);
  const reviewer = operators.find(item => item.id === task.reviewerProfileId);
  const workflowActions = taskWorkflowCardActions(task, viewerProfileId);
  return <li ref={setNodeRef} data-task-id={task.id} aria-busy={saving || undefined}
    className={`${styles.card} ${selected ? styles.selectedCard : ""} ${isDragging ? styles.draggingCard : ""} ${draggable && !disabled ? styles.draggableCard : ""}`}
    onPointerDown={event => {
      // The title still opens on a click. Moving past the sensor threshold starts
      // a drag and dnd-kit suppresses that click; other card actions never drag.
      const button = (event.target as HTMLElement).closest("button");
      if (button && !button.hasAttribute("data-task-title") && !button.hasAttribute("data-task-drag-handle")) return;
      listeners?.onPointerDown?.(event);
    }}>
    <div className={styles.cardTop}>
      <span className={`${styles.priority} ${styles[task.priority] ?? ""}`}>{taskPriorityLabels[task.priority]}</span>
      {workflowEnabled && <span className={`${styles.stageBadge} ${styles[stage]}`}>{taskWorkflowLabels[stage]}</span>}
      {dirty && <span className={styles.draftBadge}>Neuložený koncept</span>}
      {draggable && <button ref={setActivatorNodeRef} type="button" {...attributes} onKeyDown={event => listeners?.onKeyDown?.(event)}
        data-task-drag-handle className={styles.dragHandle} disabled={disabled} aria-label={`Presunúť úlohu ${task.title}`}
        title={dirty ? "Pred presunom uložte rozpracovanú úlohu." : workflowEnabled ? "Potiahnutím zmeniť pracovný stav. Termín zostane." : "Potiahnutím zmeniť stav alebo termín úlohy"}><GripVertical size={16} aria-hidden="true" /></button>}
    </div>
    <button type="button" data-task-title className={styles.title} aria-current={selected ? "true" : undefined} onClick={() => onSelect(task.id)}>{task.title}</button>
    <div className={styles.caseTags}>{task.caseLinks.length ? task.caseLinks.map(link => <span key={link.caseId}>{link.caseNumber}</span>) : <span>Samostatná úloha</span>}</div>
    <div className={styles.cardFooter}>
      <span className={styles.assignee}><span className={styles.avatar} aria-hidden="true">{operator ? operator.name.split(" ").filter(Boolean).slice(0, 2).map(part => part[0]).join("") : "—"}</span>{operator?.name ?? "Nepriradené"}</span>
      <span className={isTaskOverdue(task, now) ? styles.overdueDate : styles.date}><Clock3 size={12} aria-hidden="true" />{task.dueAt && Number.isFinite(new Date(task.dueAt).getTime()) ? new Date(task.dueAt).toLocaleString("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "Bez termínu"}</span>
    </div>
    {workflowEnabled && task.reviewerProfileId && <p className={styles.reviewerLine}><UserRoundCheck size={13} aria-hidden="true" /><span>{stage === "in_review" ? "Kontroluje" : "Kontrolór"}: <strong>{reviewer?.name ?? "Určený kolega"}</strong></span></p>}
    {workflowEnabled && task.reviewReturnReason && stage === "in_progress" && <p className={styles.returnedBadge}>Vrátené na dopracovanie · dôvod v detaile</p>}
    {workflowEnabled ? <div className={styles.cardWorkflowActions}>{workflowActions.map((nextAction, index) => <button type="button" key={nextAction} data-task-status-action className={index === 0 ? styles.workflowPrimary : styles.workflowSecondary} disabled={disabled}
      aria-label={`${workflowActionLabels[nextAction]} úlohu ${task.title}`} onClick={() => onWorkflowAction?.(task, nextAction)}>{saving ? "Ukladám…" : workflowActionLabels[nextAction]}</button>)}
      {workflowActions.length === 0 && <span className={styles.waitingReview}>Čaká na potvrdenie kontrolóra</span>}
    </div> : <button type="button" data-task-status-action className={styles.statusAction} disabled={disabled} aria-label={`${action} úlohu ${task.title}`}
      title={dirty ? "Pred zmenou stavu uložte rozpracovanú úlohu." : undefined}
      onClick={() => onStatusChange(task, task.status === "done" ? "open" : "done")}>
      {task.status === "done" ? <RotateCcw size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}{saving ? "Ukladám…" : action}
    </button>}
  </li>;
}

type BoardProps = {
  columns: ReturnType<typeof groupTaskBoard>;
  boardRef: RefObject<HTMLElement | null>;
  loading: boolean;
  filtered: boolean;
  now: Date;
  cardProps: (task: WorkspaceTask) => TaskWorkspaceCardProps;
  onMove: (task: WorkspaceTask, column: TaskBoardColumnId) => void;
};

// Arrow keys visit the valid columns in one step, including columns currently
// outside the horizontal viewport. The keyboard sensor handles scrolling.
function columnKeyboardCoordinates(event: KeyboardEvent, { currentCoordinates, context }: Parameters<KeyboardCoordinateGetter>[1], task: WorkspaceTask | null, now: Date) {
  if (!task || !["ArrowLeft", "ArrowRight"].includes(event.code) || !context.collisionRect) return;
  event.preventDefault();
  const direction = event.code === "ArrowRight" ? 1 : -1;
  const current = context.collisionRect;
  const centerX = current.left + current.width / 2;
  const targets = context.droppableContainers.getEnabled().flatMap(container => {
    if (!taskBoardDrop(task, String(container.id), now)) return [];
    const rect = context.droppableRects.get(container.id);
    return rect ? [{ rect, x: rect.left + rect.width / 2 }] : [];
  }).filter(target => direction > 0 ? target.x > centerX + 1 : target.x < centerX - 1)
    .sort((a, b) => direction * (a.x - b.x));
  const target = targets[0];
  if (target) return { x: currentCoordinates.x + target.x - centerX, y: currentCoordinates.y + target.rect.top + Math.min(target.rect.height / 2, current.height / 2 + 48) - (current.top + current.height / 2) };
}

export function TaskWorkspaceBoard({ columns, boardRef, cardProps, loading, filtered, now, onMove }: BoardProps) {
  const id = useId();
  const [dragged, setDragged] = useState<WorkspaceTask | null>(null);
  const dragStartTask = useRef<WorkspaceTask | null>(null);
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => columnKeyboardCoordinates(event, args, dragStartTask.current, now);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" }));
  const collisionDetection: CollisionDetection = args => {
    const task = dragStartTask.current;
    if (!task) return [];
    const candidates = { ...args, droppableContainers: args.droppableContainers.filter(container => taskBoardDrop(task, String(container.id), now)) };
    if (args.pointerCoordinates) {
      const bounds = boardRef.current?.getBoundingClientRect();
      const { x, y } = args.pointerCoordinates;
      if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return [];
      return pointerWithin(candidates);
    }
    return rectIntersection(candidates);
  };
  function endDrag() { dragStartTask.current = null; setDragged(null); }
  return <DndContext id={id} sensors={sensors} collisionDetection={collisionDetection} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    accessibility={{
      restoreFocus: false,
      screenReaderInstructions: { draggable: "Medzerníkom alebo Enterom zdvihnite úlohu. Šípkami vľavo a vpravo vyberte cieľový stĺpec a medzerníkom alebo Enterom potvrďte. Escape presun zruší. Dnes nastaví dnešný termín, Bez termínu ho odstráni. Naplánované a Po termíne otvoria výber termínu." },
      announcements: {
        onDragStart: () => "Úloha je zdvihnutá. Vyberte cieľový stĺpec.",
        onDragOver: ({ over }) => over ? `Cieľ: ${columns.find(column => column.id === over.id)?.label ?? ""}. ${dropHints[over.id as TaskBoardColumnId] ?? ""}` : "Tu nie je možné presunúť úlohu.",
        onDragEnd: ({ over }) => over ? "Presun ukončený. Výsledok uloženia sa zobrazí na tabuli." : "Presun zrušený.",
        onDragCancel: () => "Presun zrušený.",
      },
    }}
    onDragStart={({ active }) => {
      const task = columns.flatMap(column => column.tasks).find(item => item.id === active.id);
      if (!task || cardProps(task).disabled) return;
      dragStartTask.current = { ...task }; setDragged(task);
    }}
    onDragCancel={endDrag}
    onDragEnd={({ over }) => {
      const task = dragStartTask.current;
      endDrag();
      if (task && over && taskBoardDrop(task, String(over.id), new Date())) onMove(task, over.id as TaskBoardColumnId);
    }}>
    <section ref={boardRef} className={`${styles.board} ${dragged ? styles.dragActive : ""}`} aria-label="Tabuľa úloh" tabIndex={0}>
      {columns.map(column => <TaskBoardColumn key={column.id} column={column} dragged={dragged} loading={loading} filtered={filtered} now={now} cardProps={cardProps} />)}
    </section>
    {typeof document !== "undefined" && createPortal(<DragOverlay dropAnimation={null} zIndex={2147483600}>
      {dragged && <div className={`${styles.card} ${styles.dragOverlay}`} aria-hidden="true"><span className={`${styles.priority} ${styles[dragged.priority] ?? ""}`}>{taskPriorityLabels[dragged.priority]}</span><p>{dragged.title}</p></div>}
    </DragOverlay>, document.body)}
  </DndContext>;
}

const dropHints: Record<TaskBoardColumnId, string> = {
  overdue: "Pustením vybrať minulý termín",
  today: "Pustením nastaviť termín na dnes",
  scheduled: "Pustením vybrať budúci termín",
  undated: "Pustením odstrániť termín",
  done: "Pustením vybaviť úlohu",
};

function TaskBoardColumn({ column, dragged, loading, filtered, now, cardProps }: Pick<BoardProps, "cardProps" | "loading" | "filtered" | "now"> & { column: BoardProps["columns"][number]; dragged: WorkspaceTask | null }) {
  const allowed = Boolean(dragged && taskBoardDrop(dragged, column.id, now));
  // Measure even at rest so a keyboard arrow immediately after pickup has
  // destinations. Validity is filtered centrally from the captured task.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return <section ref={setNodeRef} data-task-column={column.id} data-drop-allowed={allowed || undefined} data-drop-over={isOver || undefined}
    className={`${styles.column} ${styles[column.id] ?? ""} ${allowed ? styles.dropAllowed : ""} ${isOver ? styles.dropOver : ""}`} aria-label={column.label}>
    <header className={styles.columnHeader}><div>{column.id === "done" ? <CheckCircle2 size={14} aria-hidden="true" /> : column.id === "overdue" ? <Clock3 size={14} aria-hidden="true" /> : <CalendarDays size={14} aria-hidden="true" />}<h3>{column.label}</h3></div><span>{column.tasks.length}</span></header>
    {allowed && <p className={styles.dropHint}>{dropHints[column.id]}</p>}
    <ul className={styles.columnList}>{column.tasks.map(task => <TaskWorkspaceCard key={task.id} {...cardProps(task)} draggable />)}{column.tasks.length === 0 && <li className={styles.emptyColumn}>{loading ? "Načítavam…" : filtered ? "Žiadne úlohy pre tento filter." : column.empty}</li>}</ul>
  </section>;
}
