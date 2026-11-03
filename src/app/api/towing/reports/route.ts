import { actorRpcParams, requireTowingRequestActor } from '@/server/towing/auth';
import { towingAdmin } from '@/server/towing/client';
import { mapRpcError, towingErrorResponse, towingJson, TowingError, uuid } from '@/server/towing/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireTowingRequestActor(request, 'report');
    const params = new URL(request.url).searchParams;
    const from = params.get('from'); const to = params.get('to');
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      throw new TowingError('invalid_input', 400, 'Vyberte obdobie prehľadu.');
    const filters: Record<string, string> = {};
    for (const key of ['branchId','driverId','fleetAssetId']) if (params.get(key)) filters[key] = uuid(params.get(key));
    const result = await towingAdmin().rpc('motorist_towing_report', { ...actorRpcParams(actor), p_from: from, p_to: to, p_filters: filters });
    mapRpcError(result.error);
    return towingJson(result.data);
  } catch (error) { return towingErrorResponse(error); }
}
