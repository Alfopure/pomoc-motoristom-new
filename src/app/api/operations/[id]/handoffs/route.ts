import { commandOperationGrant, getOperationGrantContext, operationGrantError, operationGrantJson } from '@/server/operations/grants';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { return operationGrantJson(await getOperationGrantContext((await context.params).id)); } catch (error) { return operationGrantError(error); }
}
export async function POST(request: Request, context: Context) {
  try { return operationGrantJson(await commandOperationGrant(request, (await context.params).id)); } catch (error) { return operationGrantError(error); }
}
