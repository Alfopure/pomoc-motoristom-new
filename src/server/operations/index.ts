import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OperationCommand, OperationReceipt, OperationsActor, OperationsWorkspace } from '@/domain/operations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { TowingError, mapRpcError, uuid, revision } from '@/server/towing/http';
const admin = () => createSupabaseAdminClient() as unknown as SupabaseClient;
export async function requireOperationsActor(): Promise<OperationsActor> {
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new TowingError('unauthenticated', 401, 'Prihláste sa do aplikácie.');
  const result = await admin().rpc('motorist_operations_actor', { p_user_id: data.user.id, p_organization_id: await resolveDefaultOrganizationId() });
  mapRpcError(result.error);
  if (!result.data) throw new TowingError('access_denied', 403, 'Nemáte prístup k jazdám.');
  return result.data as OperationsActor;
}
const params = (actor: OperationsActor) => ({ p_user_id: actor.userId, p_organization_id: actor.organizationId });
export async function getOperationsWorkspace(filters: Record<string, unknown> = {}): Promise<OperationsWorkspace> {
  const actor = await requireOperationsActor();
  const checkedFilters = { ...filters };
  for (const key of ['id', 'ownerId', 'caseId']) {
    if (checkedFilters[key] !== undefined) checkedFilters[key] = uuid(checkedFilters[key]);
  }
  const result = await admin().rpc('motorist_operations_workspace', { ...params(actor), p_filters: checkedFilters });
  mapRpcError(result.error);
  return result.data as OperationsWorkspace;
}
export function parseOperationCommand(value: Record<string, unknown>, operationId?: string): OperationCommand {
  const actions = ['link_towing_return','create','assign','confirm','start','accept','arrive','collect','complete','cancel','reschedule','return','evidence','inspect'];
  if (typeof value.action !== 'string' || !actions.includes(value.action) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))
    throw new TowingError('invalid_input', 400, 'Neplatný príkaz jazdy.');
  return { commandId: uuid(value.commandId), action: value.action as OperationCommand['action'], expectedRevision: revision(value.expectedRevision),
    ...(operationId || value.operationId ? { operationId: uuid(operationId ?? value.operationId) } : {}), payload: value.payload as Record<string, unknown> };
}
export async function commandOperation(command: OperationCommand): Promise<OperationReceipt> {
  const actor = await requireOperationsActor();
  const result = await admin().rpc('motorist_operations_command', { ...params(actor), p_command: command });
  mapRpcError(result.error);
  return result.data as OperationReceipt;
}
