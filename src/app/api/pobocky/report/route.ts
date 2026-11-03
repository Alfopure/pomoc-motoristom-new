import { getBranchReport } from '@/server/branches/service';
import { towingErrorResponse, towingJson } from '@/server/towing/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return towingJson(await getBranchReport(Object.fromEntries(new URL(request.url).searchParams))); }
  catch (error) { return towingErrorResponse(error); }
}
