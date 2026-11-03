import { commandBranch, getBranchWorkspace } from '@/server/branches/service';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from '@/server/towing/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return towingJson(await getBranchWorkspace(Object.fromEntries(new URL(request.url).searchParams))); }
  catch (error) { return towingErrorResponse(error); }
}
export async function POST(request: Request) {
  try { assertTowingOrigin(request); return towingJson(await commandBranch(await boundedJson(request, 32_000))); }
  catch (error) { return towingErrorResponse(error); }
}
