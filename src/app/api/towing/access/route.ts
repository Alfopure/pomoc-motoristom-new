import { actorRpcParams, requireTowingRequestActor } from '@/server/towing/auth';
import type { TowingOrder } from '@/domain/towing/types';
import { projectTowingDriverOrder } from '@/server/towing/service';
import { towingAdmin } from '@/server/towing/client';
import { mapRpcError, towingErrorResponse, towingJson, TowingError, uuid, revision } from '@/server/towing/http';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireTowingRequestActor(request,'drive');
    const url = new URL(request.url); const orderId = uuid(url.searchParams.get('orderId'));
    const generation = url.searchParams.get('assignmentGeneration');
    const expectedGeneration = generation === null ? null : revision(Number(generation));
    const result = await towingAdmin().rpc('motorist_towing_access',{...actorRpcParams(actor),p_order_id:orderId,p_assignment_generation:expectedGeneration});
    if (result.error?.code === 'PT403') throw new TowingError('assignment_revoked',403,'Pridelenie zákazky už nie je platné.');
    mapRpcError(result.error);
    const data = result.data as {order?:TowingOrder;cashAccount:unknown} | null;
    if (!data?.order || data.order.id !== orderId || data.order.driverId !== actor.id || (expectedGeneration !== null && data.order.assignmentGeneration !== expectedGeneration))
      throw new TowingError('unavailable',503,'Pridelenie sa nepodarilo overiť.');
    const issuedAt = Date.now();
    return towingJson({actor,order:projectTowingDriverOrder(data.order,actor),cashAccount:data.cashAccount ?? null,lease:{issuedAt,expiresAt:issuedAt+12*60*60*1000}});
  } catch(error) { return towingErrorResponse(error); }
}
