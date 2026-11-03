import { actorRpcParams, requireTowingRequestActor } from '@/server/towing/auth';
import { towingAdmin } from '@/server/towing/client';
import { mapRpcError, towingErrorResponse, towingJson, TowingError, uuid } from '@/server/towing/http';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { const actor = await requireTowingRequestActor(request,'operate'); const url = new URL(request.url); const query = url.searchParams.get('query') ?? '';
    if (query.length > 120) throw new TowingError('invalid_input',400,'Vyhľadávanie je príliš dlhé.');
    const sourceId = url.searchParams.get('sourceId');
    const result = await towingAdmin().rpc('motorist_towing_sources',{...actorRpcParams(actor),p_query:query,p_source_id:sourceId ? uuid(sourceId) : null});
    mapRpcError(result.error); return towingJson(result.data);
  } catch(error) { return towingErrorResponse(error); }
}
