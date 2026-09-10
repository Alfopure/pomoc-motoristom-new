import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { linkWorkspaceTask, readTaskBody, TASK_WORKSPACE_ROLES, taskErrorResponse, taskResponse } from "@/server/tasks";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
async function mutate(request: Request, context: Context, unlink: boolean) { try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); const body = await readTaskBody(request); return taskResponse({ task: await linkWorkspaceTask(actor, (await context.params).id, body.caseId, body.expectedRevision, unlink) }); } catch (error) { return taskErrorResponse(error); } }
export async function POST(request: Request, context: Context) { return mutate(request, context, false); }
export async function DELETE(request: Request, context: Context) { return mutate(request, context, true); }
