import { commandOperation, getOperationsWorkspace, parseOperationCommand } from '@/server/operations';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from '@/server/towing/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const query = new URL(request.url).searchParams; return towingJson(await getOperationsWorkspace(Object.fromEntries(query))); }
  catch (error) { return towingErrorResponse(error); }
}
export async function POST(request: Request) {
  try { assertTowingOrigin(request); return towingJson(await commandOperation(parseOperationCommand(await boundedJson(request, 32_000)))); }
  catch (error) { return towingErrorResponse(error); }
}
