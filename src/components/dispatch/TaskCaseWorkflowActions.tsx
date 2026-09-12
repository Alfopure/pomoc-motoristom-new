"use client";

import { ArrowUpRight, ClipboardCheck } from "lucide-react";
import { canReviewTask, taskWorkflowLabels, taskWorkflowState } from "@/domain/task-workflow";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import styles from "./TaskWorkspacePanel.module.css";

/** The case card opens the same canonical task instead of bypassing its review. */
export function TaskCaseWorkflowActions({ taskId, viewerProfileId, onOpenTask }: {
  taskId: string; viewerProfileId?: string; onOpenTask: (taskId: string) => void;
}) {
  const { snapshot } = useTaskWorkspace();
  const task = snapshot.tasks.find(task => task.id === taskId);
  const review = task && canReviewTask(task, viewerProfileId);
  return <div className={styles.caseWorkflowActions}>
    {task && snapshot.workflowEnabled && <span className={`${styles.stageBadge} ${styles[taskWorkflowState(task)]}`}>{taskWorkflowLabels[taskWorkflowState(task)]}</span>}
    <button type="button" disabled={snapshot.hidden} onClick={() => onOpenTask(taskId)}>{review ? <ClipboardCheck size={13} aria-hidden="true" /> : <ArrowUpRight size={13} aria-hidden="true" />}{review ? "Skontrolovať úlohu" : "Otvoriť úlohu"}</button>
  </div>;
}
