import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRentalDraft, type RentalDraftPreview, type RentalDraftSource } from '@/domain/rental-draft';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireOperationsActor } from '@/server/operations';
import { TowingError, mapRpcError, uuid } from '@/server/towing/http';

/** Preview of the rental draft for one delivery. The live adapter (create/look up a draft
 * in the rental system) is added only after the contract with Braňo; until then this
 * never calls the external system and never reports a transfer. */
export async function getRentalDraftPreview(operationId: string): Promise<RentalDraftPreview> {
  const actor = await requireOperationsActor();
  if (!actor.canDispatch) throw new TowingError('access_denied', 403, 'Nájom pripravuje kancelária.');
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const result = await admin.rpc('motorist_rental_draft_source', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_operation_id: uuid(operationId) });
  if (result.error?.code === 'P0002') throw new TowingError('not_found', 404, 'Nájom sa pripravuje iba pri pristavení náhradného vozidla.');
  mapRpcError(result.error);
  return buildRentalDraft(result.data as RentalDraftSource);
}
