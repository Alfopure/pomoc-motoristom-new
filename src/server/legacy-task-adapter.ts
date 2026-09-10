import "server-only";
import type { CaseActionInput } from "@/data/case-inputs";
import { defaultTaskTitle } from "@/domain/tasks";
import { createWorkspaceTask, deleteWorkspaceTask, loadWorkspaceTask, updateWorkspaceTask } from "./tasks";
import { loadWorkspaceCapabilities } from "./workspace-capabilities";
import { MutationError } from "./mutation-error";

const taskActions = new Set(["create_task", "update_task", "complete_task", "delete_task", "callback_15", "callback_30", "callback_60"]);

/** Called before the legacy workflow performs ANY reminder/event/task writes. */
export async function runCompatibleCaseTaskAction(organizationId: string, actorProfileId: string | null, caseId: string, input: CaseActionInput): Promise<boolean> {
  if (!taskActions.has(input.action)) return false;
  if (!actorProfileId) throw new MutationError("Na zmenu úlohy sa musíte prihlásiť.", 403);
  const actor = { organizationId, profileId: actorProfileId };
  if (!(await loadWorkspaceCapabilities(actor)).tasks) return false;
  const callbackMinutes = input.action.startsWith("callback_") ? Number(input.action.slice(9)) : null;
  if (input.action === "create_task" || callbackMinutes) {
    const kind = input.taskKind ?? (callbackMinutes ? "callback" : "other");
    await createWorkspaceTask(actor, {
      title: input.taskTitle?.trim() || (callbackMinutes ? `Zavolať zákazníkovi o ${callbackMinutes} min` : defaultTaskTitle(kind)),
      caseIds: [caseId], assignedTo: input.assignedTo === "unassigned" ? null : input.assignedTo ?? actorProfileId,
      dueAt: input.taskDueAt ?? (callbackMinutes ? new Date(Date.now() + callbackMinutes * 60_000).toISOString() : null),
      priority: input.taskPriority ?? "normal", kind, reminderChannels: input.taskReminderChannels ?? ["in_app"], note: input.note,
    });
    return true;
  }
  if (!input.taskId) throw new MutationError("Chýba úloha.", 400);
  // The old URL is context, never permission to mutate a task linked to another case.
  const task = await loadWorkspaceTask(actor, input.taskId);
  if (!task.caseIds.includes(caseId)) throw new MutationError("Úloha nie je pripojená k tomuto prípadu.", 404);
  if (input.action === "delete_task") {
    await deleteWorkspaceTask(actor, input.taskId, input.taskExpectedRevision, input.note);
  } else {
    const patch: Record<string, unknown> = { expectedRevision: input.taskExpectedRevision };
    if (input.action === "complete_task") patch.status = "done";
    else if (input.taskStatus !== undefined) patch.status = input.taskStatus;
    if (input.taskTitle !== undefined) patch.title = input.taskTitle;
    if (input.taskDueAt !== undefined) patch.dueAt = input.taskDueAt;
    if (input.taskPriority !== undefined) patch.priority = input.taskPriority;
    if (input.taskKind !== undefined) patch.kind = input.taskKind;
    if (input.taskReminderChannels !== undefined) patch.reminderChannels = input.taskReminderChannels;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo === "unassigned" ? null : input.assignedTo;
    if (input.note !== undefined) patch.note = input.note;
    await updateWorkspaceTask(actor, input.taskId, patch);
  }
  return true;
}
