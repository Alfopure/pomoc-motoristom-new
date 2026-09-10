import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { deleteWorkspaceTask, loadWorkspaceTask, readTaskBody, TASK_WORKSPACE_ROLES, taskErrorResponse, taskResponse, updateWorkspaceTask } from "@/server/tasks";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) { try { const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); return taskResponse({ task: await loadWorkspaceTask(actor, (await context.params).id) }); } catch (error) { return taskErrorResponse(error); } }
export async function PATCH(request: Request, context: Context) { try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); return taskResponse({ task: await updateWorkspaceTask(actor, (await context.params).id, await readTaskBody(request)) }); } catch (error) { return taskErrorResponse(error); } }
export async function DELETE(request: Request, context: Context) { try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); return taskResponse(await deleteWorkspaceTask(actor, (await context.params).id, (await readTaskBody(request)).expectedRevision)); } catch (error) { return taskErrorResponse(error); } }
