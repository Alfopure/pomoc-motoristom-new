import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { readTaskBody, TASK_WORKSPACE_ROLES, taskErrorResponse, taskResponse } from "@/server/tasks";
import { transitionWorkspaceTask } from "@/server/task-workflow";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]);
    return taskResponse(await transitionWorkspaceTask(actor, (await context.params).id, await readTaskBody(request)));
  } catch (error) { return taskErrorResponse(error); }
}
