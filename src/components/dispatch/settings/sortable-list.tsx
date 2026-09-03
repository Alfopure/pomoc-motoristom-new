"use client";

import type { ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

/**
 * Drag-and-drop scaffolding shared by the ring group and ring plan editors.
 *
 * Only the rendering lives here: the reorder itself is a pure array move in
 * `ring-groups-model.ts` / `ring-plan-model.ts`, which is what the unit tests
 * exercise. The keyboard sensor is not optional — ordering an on-call rota with
 * a mouse only would exclude keyboard users from the one control that decides
 * who rings first.
 */

export function SortableList({ items, onMove, children }: { items: readonly string[]; onMove: (activeKey: string, overKey: string) => void; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        const over = event.over;
        if (over && event.active.id !== over.id) onMove(String(event.active.id), String(over.id));
      }}
    >
      <SortableContext items={[...items]} strategy={verticalListSortingStrategy}>
        <div className="grid gap-2">{children}</div>
      </SortableContext>
    </DndContext>
  );
}

export function SortableRow({ children, handleLabel, id, disabled = false }: { children: ReactNode; handleLabel: string; id: string; disabled?: boolean }) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-start gap-2 rounded-md border p-2 ${isDragging ? "border-yellow-400 bg-yellow-50 shadow-md" : "border-zinc-200 bg-white"}`}
    >
      <button
        type="button"
        aria-label={handleLabel}
        disabled={disabled}
        className="mt-1 flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-40"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
