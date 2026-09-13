import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TASK_REVIEW_COMMENT_LIMIT, taskWorkflowActions, taskWorkflowStates, type TaskWorkflowCommand, type TaskWorkflowReceipt } from "@/domain/task-workflow";
import { MutationError } from "./mutation-error";
import { taskId, type TaskWorkspaceActor } from "./tasks";

export function validateTaskWorkflowCommand(input: Record<string, unknown>): TaskWorkflowCommand {
  if (typeof input.action !== "string" || !taskWorkflowActions.includes(input.action as TaskWorkflowCommand["action"])) throw new MutationError("Neplatná zmena stavu úlohy.", 400);
  if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision > 2_147_483_647) throw new MutationError("Chýba aktuálna verzia úlohy.", 400);
  const command: TaskWorkflowCommand = { action: input.action as TaskWorkflowCommand["action"], expectedRevision: input.expectedRevision, commandId: taskId(input.commandId) };
  if (input.comment !== undefined) {
    if (typeof input.comment !== "string" || input.comment.length > TASK_REVIEW_COMMENT_LIMIT) throw new MutationError("Komentár môže mať najviac 10 000 znakov.", 400);
    command.comment = input.comment.trim();
  }
  if (command.action === "submit_review") command.reviewerProfileId = taskId(input.reviewerProfileId);
  if ((command.action === "submit_review" || command.action === "return") && !command.comment) throw new MutationError(command.action === "return" ? "Napíšte dôvod vrátenia na dopracovanie." : "Napíšte výsledok práce alebo pokyn pre kontrolóra.", 400);
  return command;
}

function workflowError(error: { code?: string; message?: string }): MutationError {
  if (error.code === "PGRST202" || error.code === "42883" || error.code === "55000") return new MutationError("Pracovné stavy a kontrola úloh ešte nie sú aktivované v databáze tejto aplikácie.", 503);
  if (error.code === "42501") return new MutationError("Na túto zmenu úlohy nemáte oprávnenie. Schváliť alebo vrátiť úlohu môže jej kontrolór.", 403);
  if (error.code === "P0002") return new MutationError("Úloha nie je dostupná.", 404);
  if (["PT409", "40001", "23505"].includes(error.code ?? "")) return new MutationError("Úloha alebo požiadavka sa medzičasom zmenila. Načítajte aktuálnu verziu.", 409);
  if (["22023", "22P02", "23514"].includes(error.code ?? "")) {
    if (error.message === "Task review required") return new MutationError("Táto úloha vyžaduje kontrolu. Odovzdajte ju kontrolórovi; vybaviť ju môže až po schválení.", 400);
    if (error.message === "Invalid task reviewer") return new MutationError("Vyberte aktívneho kolegu odlišného od zodpovednej osoby a od seba.", 400);
    return new MutationError("Skontrolujte stav úlohy, kontrolóra a komentár k zmene.", 400);
  }
  return new MutationError("Zmenu stavu úlohy sa nepodarilo overiť. Skúste tú istú požiadavku znova.", 503);
}

export async function taskWorkflowEnabled(actor: TaskWorkspaceActor): Promise<boolean> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_task_workflow_enabled", { p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId });
  if (error?.code === "PGRST202" || error?.code === "42883") return false;
  if (error) throw workflowError(error);
  return data === true;
}

export async function transitionWorkspaceTask(actor: TaskWorkspaceActor, id: string, input: Record<string, unknown>): Promise<TaskWorkflowReceipt> {
  const command = validateTaskWorkflowCommand(input), task = taskId(id);
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_task_workflow", { p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId, p_task_id: task, p_input: { ...command } });
  if (error) throw workflowError(error);
  const receipt = data as unknown as TaskWorkflowReceipt;
  if (!receipt?.task || receipt.task.id !== task || receipt.task.workflowVersion !== 1 || !receipt.task.workflowState || !taskWorkflowStates.includes(receipt.task.workflowState)
    || !["open", "done", "overdue"].includes(receipt.task.status) || (receipt.task.status === "done") !== (receipt.task.workflowState === "done")
    || receipt.commandId !== command.commandId || !Number.isSafeInteger(receipt.committedRevision) || receipt.committedRevision < 1 || !Number.isSafeInteger(receipt.task.revision) || receipt.task.revision < receipt.committedRevision) throw new MutationError("Potvrdenie zmeny úlohy sa nepodarilo overiť. Skúste tú istú požiadavku znova.", 503);
  return receipt;
}
