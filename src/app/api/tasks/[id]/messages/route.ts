import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { loadTaskMessages, readTaskBody, sendTaskMessage, TASK_WORKSPACE_ROLES, taskErrorResponse, taskResponse } from "@/server/tasks";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { try { const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); const params = new URL(request.url).searchParams; const createdAt = params.get("beforeCreatedAt"), id = params.get("beforeId"); return taskResponse(await loadTaskMessages(actor, (await context.params).id, createdAt || id ? { createdAt: createdAt ?? "", id: id ?? "" } : undefined)); } catch (error) { return taskErrorResponse(error); } }
export async function POST(request: Request, context: Context) { try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); return taskResponse({ message: await sendTaskMessage(actor, (await context.params).id, await readTaskBody(request)) }, 201); } catch (error) { return taskErrorResponse(error); } }
