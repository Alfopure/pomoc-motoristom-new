"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, MeasuringStrategy, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { CheckCircle2, Circle, CircleDot, ClipboardCheck } from "lucide-react";
import type { WorkspaceTask } from "@/domain/task-workspace";
import type { TaskWorkflowAction, TaskWorkflowState } from "@/domain/task-workflow";
import { TaskWorkspaceCard, type TaskWorkspaceCardProps } from "./TaskWorkspaceBoard";
import { groupWorkflowBoard, workflowDropAction } from "./task-workflow-board";
import styles from "./TaskWorkspacePanel.module.css";

type Column = ReturnType<typeof groupWorkflowBoard>[number];
type Props = { columns: Column[]; boardRef: RefObject<HTMLElement | null>; cardProps: (task: WorkspaceTask) => TaskWorkspaceCardProps;
  viewerProfileId?: string; loading: boolean; onAction: (task: WorkspaceTask, action: TaskWorkflowAction) => void };
const icons = { todo: Circle, in_progress: CircleDot, in_review: ClipboardCheck, done: CheckCircle2 };

export function TaskWorkflowBoard({ columns, boardRef, cardProps, viewerProfileId, loading, onAction }: Props) {
  const id = useId();
  const [dragged, setDragged] = useState<WorkspaceTask | null>(null);
  const dragTask = useRef<WorkspaceTask | null>(null);
  const dialogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (dialogTimer.current) clearTimeout(dialogTimer.current); }, []);
  const coordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    if (!dragTask.current || !["ArrowLeft", "ArrowRight"].includes(event.code) || !context.collisionRect) return;
    event.preventDefault();
    const direction = event.code === "ArrowRight" ? 1 : -1;
    const current = context.collisionRect, x = current.left + current.width / 2;
    const target = context.droppableContainers.getEnabled().flatMap(container => {
      if (!workflowDropAction(dragTask.current!, String(container.id), viewerProfileId)) return [];
      const rect = context.droppableRects.get(container.id);
      return rect ? [{ rect, x: rect.left + rect.width / 2 }] : [];
    }).filter(target => direction * (target.x - x) > 1).sort((a, b) => direction * (a.x - b.x))[0];
    if (target) return { x: currentCoordinates.x + target.x - x, y: currentCoordinates.y + target.rect.top + 60 - current.top };
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: coordinates, scrollBehavior: "auto" }));
  const collisions: CollisionDetection = args => {
    if (!dragTask.current) return [];
    const valid = { ...args, droppableContainers: args.droppableContainers.filter(container => workflowDropAction(dragTask.current!, String(container.id), viewerProfileId)) };
    if (args.pointerCoordinates) {
      const bounds = boardRef.current?.getBoundingClientRect(), { x, y } = args.pointerCoordinates;
      if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return [];
      return pointerWithin(valid);
    }
    return rectIntersection(valid);
  };
  const end = () => { dragTask.current = null; setDragged(null); };
  return <DndContext id={id} sensors={sensors} collisionDetection={collisions} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    accessibility={{ restoreFocus: false, screenReaderInstructions: { draggable: "Medzerníkom zdvihnite úlohu. Šípkami vľavo a vpravo vyberte pracovný stav, medzerníkom potvrďte. Escape zruší presun. Termín sa nemení. Kontrola otvorí výber kolegu a výsledku." },
      announcements: { onDragStart: () => "Úloha je zdvihnutá. Vyberte pracovný stav.", onDragOver: ({ over }) => over ? `Cieľ: ${columns.find(column => column.id === over.id)?.label ?? ""}. Termín sa nemení.` : "Tu sa úloha nedá presunúť.", onDragEnd: ({ over }) => over ? "Presun potvrdený. Skontrolujte výsledok alebo doplňte údaje v dialógu." : "Presun zrušený.", onDragCancel: () => "Presun zrušený." } }}
    onDragStart={({ active }) => { const task = columns.flatMap(column => column.tasks).find(task => task.id === active.id); if (task && !cardProps(task).disabled) { dragTask.current = { ...task }; setDragged(task); } }}
    onDragCancel={end} onDragEnd={({ over }) => {
      const task = dragTask.current; end();
      if (!task || !over) return;
      const action = workflowDropAction(task, String(over.id), viewerProfileId);
      if (!action) return;
      if (action === "submit_review" || action === "return") {
        // PointerSensor suppresses document clicks for 50ms after dropping.
        // Open the modal afterwards so its first Cancel/Confirm click works.
        if (dialogTimer.current) clearTimeout(dialogTimer.current);
        dialogTimer.current = setTimeout(() => { dialogTimer.current = null; onAction(task, action); }, 60);
      } else onAction(task, action);
    }}>
    <section ref={boardRef} className={`${styles.board} ${styles.workflowBoard} ${dragged ? styles.dragActive : ""}`} aria-label="Tabuľa úloh" tabIndex={0}>
      {columns.map(column => <WorkflowColumn key={column.id} column={column} dragged={dragged} viewerProfileId={viewerProfileId} loading={loading} cardProps={cardProps} />)}
    </section>
    {typeof document !== "undefined" && createPortal(<DragOverlay dropAnimation={null} zIndex={2147483600}>{dragged && <div className={`${styles.card} ${styles.dragOverlay}`} aria-hidden="true">{dragged.title}</div>}</DragOverlay>, document.body)}
  </DndContext>;
}

function WorkflowColumn({ column, dragged, viewerProfileId, loading, cardProps }: Pick<Props, "viewerProfileId" | "loading" | "cardProps"> & { column: Column; dragged: WorkspaceTask | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const allowed = Boolean(dragged && workflowDropAction(dragged, column.id, viewerProfileId));
  const Icon = icons[column.id as TaskWorkflowState];
  return <section ref={setNodeRef} data-task-column={column.id} data-drop-allowed={allowed || undefined} data-drop-over={isOver || undefined}
    className={`${styles.column} ${styles[column.id]} ${allowed ? styles.dropAllowed : ""} ${isOver ? styles.dropOver : ""}`} aria-label={column.label}>
    <header className={styles.columnHeader}><div><Icon size={16} aria-hidden="true" /><h3>{column.label}</h3></div><span title="Počet úloh podľa filtrov">{column.tasks.length}</span></header>
    <p className={styles.columnDescription}>{allowed ? column.id === "in_review" ? "Vyberiete kontrolóra a doplníte výsledok" : "Termín aj pripomienka zostanú" : column.description}</p>
    <ul className={styles.columnList}>{column.tasks.map(task => <TaskWorkspaceCard key={task.id} {...cardProps(task)} draggable />)}{column.tasks.length === 0 && <li className={styles.emptyColumn}>{loading ? "Načítavam…" : "Žiadne úlohy podľa filtrov."}</li>}</ul>
  </section>;
}
