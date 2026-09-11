"use client";

import { useEffect, useId, useRef, useState } from "react";
import { taskBoardDateMutation, type TaskBoardDateColumn } from "./task-workspace-board";
import type { TaskBoardMutation } from "./task-workspace-store";
import styles from "./TaskWorkspacePanel.module.css";

export function TaskBoardMoveDialog({ title, column, suggestedDueAt, saving, error, onConfirm, onCancel }: {
  title: string;
  column: TaskBoardDateColumn;
  suggestedDueAt: string;
  saving: boolean;
  error: string;
  onConfirm: (patch: TaskBoardMutation) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), descriptionId = useId();
  const [dueAt, setDueAt] = useState(() => localTime(suggestedDueAt));
  const [validation, setValidation] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className={styles.moveDialog} aria-labelledby={headingId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!saving) onCancel(); }}>
    <form noValidate onSubmit={event => {
      event.preventDefault();
      if (saving) return;
      // Revalidate against the clock at confirmation, not when the drag began.
      const patch = taskBoardDateMutation(column, dueAt, new Date());
      if (!patch) {
        setValidation(column === "scheduled" ? "Vyberte termín od zajtra. Dnešné úlohy patria do stĺpca Dnes." : "Vyberte termín v minulosti.");
        return;
      }
      setValidation(""); onConfirm(patch);
    }}>
      <h2 id={headingId}>Presunúť úlohu do {column === "scheduled" ? "Naplánované" : "Po termíne"}</h2>
      <p className={styles.moveTaskTitle}>{title}</p>
      <p id={descriptionId}>{column === "scheduled"
        ? "Vyberte dátum a čas od zajtra. Úloha sa otvorí a presunie až po potvrdení."
        : "Potvrďte skutočný termín v minulosti. Úloha sa otvorí ako oneskorená a môže vyvolať pripomienku."} Samostatne nastavená pripomienka zostane zachovaná.</p>
      <label>Nový termín úlohy<input type="datetime-local" value={dueAt} disabled={saving} required
        aria-invalid={Boolean(validation)} onChange={event => { setDueAt(event.target.value); setValidation(""); }} /></label>
      {(validation || error) && <p role="alert" className={styles.moveError}>{validation || error}</p>}
      <div className={styles.row}>
        <button type="button" disabled={saving} onClick={onCancel}>Zrušiť</button>
        <button type="submit" className={styles.primary} disabled={saving}>{saving ? "Ukladám…" : "Potvrdiť presun"}</button>
      </div>
    </form>
  </dialog>;
}

function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
