"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ClipboardCheck, Send, UserRoundCheck } from "lucide-react";
import type { Operator } from "@/domain/types";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { TASK_REVIEW_COMMENT_LIMIT, taskWorkflowState } from "@/domain/task-workflow";
import styles from "./TaskWorkspacePanel.module.css";

export function TaskReviewDialog({ task, action, operators, viewerProfileId, saving, pending, error, onConfirm, onCancel }: {
  task: WorkspaceTask; action: "submit_review" | "return"; operators: Operator[]; viewerProfileId?: string; saving: boolean;
  pending?: { reviewerProfileId?: string; comment?: string }; error: string;
  onConfirm: (details: { reviewerProfileId?: string; comment: string }) => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), description = useId();
  const isReturn = action === "return", reselect = !isReturn && taskWorkflowState(task) === "in_review";
  const [reviewer, setReviewer] = useState(pending?.reviewerProfileId ?? (!reselect && task.reviewerProfileId !== viewerProfileId && task.reviewerProfileId !== task.assignedTo ? task.reviewerProfileId ?? "" : ""));
  const [comment, setComment] = useState(pending?.comment ?? ""), [validation, setValidation] = useState("");
  const candidates = operators.filter(operator => (!operator.accessStatus || operator.accessStatus === "active") && operator.id !== task.assignedTo && operator.id !== viewerProfileId && (!reselect || operator.id !== task.reviewerProfileId));
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className={`${styles.moveDialog} ${styles.reviewDialog}`} aria-labelledby={heading} aria-describedby={description} onCancel={event => { event.preventDefault(); if (!saving) onCancel(); }}>
    <form noValidate onSubmit={event => {
      event.preventDefault(); if (saving) return;
      if (!isReturn && !candidates.some(operator => operator.id === reviewer) && !pending) { setValidation("Vyberte iného aktívneho kolegu na kontrolu."); return; }
      if (!comment.trim()) { setValidation(isReturn ? "Napíšte, čo treba dopracovať." : "Doplňte výsledok alebo pokyn pre kontrolóra."); return; }
      if (comment.trim().length > TASK_REVIEW_COMMENT_LIMIT) { setValidation("Text môže mať najviac 10 000 znakov."); return; }
      setValidation(""); onConfirm({ ...(isReturn ? {} : { reviewerProfileId: reviewer }), comment });
    }}>
      <div className={styles.reviewDialogIcon}>{isReturn ? <ArrowLeft size={24} /> : <ClipboardCheck size={24} />}</div>
      <div><h2 id={heading}>{isReturn ? "Vrátiť na dopracovanie" : reselect ? "Zmeniť kontrolóra" : "Poslať na kontrolu"}</h2><p className={styles.moveTaskTitle}>{task.title}</p></div>
      <p id={description}>{isReturn ? "Úloha sa vráti do Rozpracované. Riešiteľ uvidí váš dôvod." : "Vybraný kolega dostane upozornenie a úlohu nájde vo svojej kontrole. Termín aj zodpovedná osoba zostanú zachované."}</p>
      {!isReturn && <label><span><UserRoundCheck size={14} aria-hidden="true" /> Kto má úlohu skontrolovať</span><select autoFocus value={reviewer} disabled={saving || Boolean(pending)} onChange={event => { setReviewer(event.target.value); setValidation(""); }} required>
        <option value="">Vyberte kontrolóra</option>{candidates.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}
      </select>{candidates.length === 0 && <small>Nie je dostupný iný aktívny kolega. Úlohu môžete ďalej upravovať bez odoslania na kontrolu.</small>}</label>}
      <label>{isReturn ? "Čo treba dopracovať" : "Výsledok a pokyn na kontrolu"}<textarea autoFocus={isReturn} rows={5} maxLength={TASK_REVIEW_COMMENT_LIMIT} value={comment} disabled={saving || Boolean(pending)} onChange={event => { setComment(event.target.value); setValidation(""); }} placeholder={isReturn ? "Doplňte konkrétny dôvod vrátenia…" : "Čo je hotové a na čo sa má kolega pozrieť…"} required /></label>
      {pending && <p className={styles.pendingNotice}>Overujeme pôvodný pokus. Text a kontrolór zostávajú rovnakí, aby nevzniklo ďalšie odoslanie.</p>}
      {(validation || error) && <p role="alert" className={styles.moveError}>{validation || error}</p>}
      <div className={styles.row}><button type="button" disabled={saving} onClick={onCancel}>Zrušiť</button><button type="submit" className={styles.primary} disabled={saving || (!isReturn && candidates.length === 0 && !pending)}><Send size={15} aria-hidden="true" />{saving ? "Ukladám…" : pending ? "Overiť pôvodný pokus" : isReturn ? "Vrátiť úlohu" : "Odoslať na kontrolu"}</button></div>
    </form>
  </dialog>;
}
