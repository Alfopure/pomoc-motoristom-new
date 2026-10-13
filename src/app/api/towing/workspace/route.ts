import { requireTowingRequestActor } from '@/server/towing/auth';
import { towingErrorResponse, towingJson, TowingError } from '@/server/towing/http';
import { loadTowingWorkspace, workspaceFilters } from '@/server/towing/service';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { const actor = await requireTowingRequestActor(request); const url = new URL(request.url); const view = url.searchParams.get('view');
    if (view !== 'office' && view !== 'driver') throw new TowingError('invalid_input',400,'Vyberte rozhranie zákaziek.');
    return towingJson(await loadTowingWorkspace(actor, view, workspaceFilters(url)));
  } catch (error) { return towingErrorResponse(error); }
}
