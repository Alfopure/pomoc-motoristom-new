import { getOperationLastPosition } from '@/server/operations';
import { towingErrorResponse, towingJson } from '@/server/towing/http';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
/** Dispatch only: the executor's latest position sent from the app during this operation. */
export async function GET(_request: Request, context: Context) {
  try { return towingJson(await getOperationLastPosition((await context.params).id)); }
  catch (error) { return towingErrorResponse(error); }
}
