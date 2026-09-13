import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { createWorkspaceTask, loadTaskWorkspace, readTaskBody, TASK_WORKSPACE_ROLES, taskErrorResponse, taskResponse } from "@/server/tasks";
import { taskWorkflowEnabled } from "@/server/task-workflow";
export const runtime = "nodejs";
export async function GET() { try { const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); const [tasks, workflowEnabled] = await Promise.all([loadTaskWorkspace(actor), taskWorkflowEnabled(actor)]); return taskResponse({ tasks, workflowEnabled }); } catch (error) { return taskErrorResponse(error); } }
export async function POST(request: Request) { try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...TASK_WORKSPACE_ROLES]); return taskResponse({ task: await createWorkspaceTask(actor, await readTaskBody(request)) }, 201); } catch (error) { return taskErrorResponse(error); } }
