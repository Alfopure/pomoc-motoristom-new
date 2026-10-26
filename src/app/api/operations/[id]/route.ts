import { commandOperation, getOperationsWorkspace, parseOperationCommand } from '@/server/operations';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from '@/server/towing/http';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: Context) {
  try { const workspace = await getOperationsWorkspace({ id: (await context.params).id }); const operation = workspace.operations[0];
    return operation ? towingJson({ actor: workspace.actor, operation }) : towingJson({ error: 'Jazda nie je dostupná.', code: 'not_found' }, 404); }
  catch (error) { return towingErrorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try { assertTowingOrigin(request); return towingJson(await commandOperation(parseOperationCommand(await boundedJson(request, 32_000), (await context.params).id))); }
  catch (error) { return towingErrorResponse(error); }
}
