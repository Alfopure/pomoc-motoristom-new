import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRentalDraft, type RentalDraftPreview } from '@/domain/rental-draft';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireOperationsActor } from '@/server/operations';
import { TowingError, uuid } from '@/server/towing/http';

/** Preview of the rental draft for one delivery. The live adapter (create/look up a draft
 * in the rental system) is added only after the contract with Braňo; until then this
 * never calls the external system and never reports a transfer. */
export async function getRentalDraftPreview(operationId: string): Promise<RentalDraftPreview> {
  const actor = await requireOperationsActor();
  if (!actor.canDispatch) throw new TowingError('access_denied', 403, 'Nájom pripravuje kancelária.');
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const op = await admin.from('motorist_operations').select('id,kind,case_id').eq('organization_id', actor.organizationId).eq('id', uuid(operationId)).maybeSingle();
  if (op.error) throw new TowingError('unavailable', 503, 'Jazdu sa nepodarilo načítať.');
  if (!op.data || op.data.kind !== 'delivery') throw new TowingError('not_found', 404, 'Nájom sa pripravuje iba pri pristavení náhradného vozidla.');
  let caseRow: { case_number: string; assistance_reference: string | null; customer_details: Record<string, unknown> | null; contact_id: string | null } | null = null;
  let contactPhone: string | null = null;
  if (op.data.case_id) {
    const found = await admin.from('motorist_cases').select('case_number,assistance_reference,customer_details,contact_id').eq('organization_id', actor.organizationId).eq('id', op.data.case_id).maybeSingle();
    caseRow = found.data;
    if (caseRow?.contact_id) contactPhone = (await admin.from('motorist_contacts').select('phone').eq('organization_id', actor.organizationId).eq('id', caseRow.contact_id).maybeSingle()).data?.phone ?? null;
  }
  // The branch comes from the branch request that created the work, when there is one.
  const request = await admin.from('motorist_work_requests').select('group_id').eq('organization_id', actor.organizationId).eq('operation_id', op.data.id).maybeSingle();
  let branchName: string | null = null;
  if (request.data?.group_id) {
    const group = await admin.from('motorist_work_groups').select('name,branch_id').eq('id', request.data.group_id).maybeSingle();
    branchName = group.data?.branch_id ? (await admin.from('motorist_branches').select('name').eq('id', group.data.branch_id).maybeSingle()).data?.name ?? group.data?.name ?? null : group.data?.name ?? null;
  }
  return buildRentalDraft({ operationId: op.data.id, caseId: op.data.case_id, caseNumber: caseRow?.case_number ?? null, caseAssistanceReference: caseRow?.assistance_reference ?? null,
    customer: (caseRow?.customer_details ?? null) as never, contactPhone, branchName });
}
