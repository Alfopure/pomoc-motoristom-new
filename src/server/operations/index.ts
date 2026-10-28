import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OperationCommand, OperationReceipt, OperationsActor, OperationsWorkspace } from '@/domain/operations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { TowingError, mapRpcError, uuid, revision } from '@/server/towing/http';
import { queueWorkPush } from '@/server/mobile/push-outbox';
const admin = () => createSupabaseAdminClient() as unknown as SupabaseClient;
/** Who the operations RPCs re-authorize: a verified user of one organization (web session or mobile bearer). */
export type OperationsUser = { userId: string; organizationId: string };
export async function requireOperationsActor(): Promise<OperationsActor> {
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new TowingError('unauthenticated', 401, 'Prihláste sa do aplikácie.');
  const result = await admin().rpc('motorist_operations_actor', { p_user_id: data.user.id, p_organization_id: await resolveDefaultOrganizationId() });
  mapRpcError(result.error);
  if (!result.data) throw new TowingError('access_denied', 403, 'Nemáte prístup k jazdám.');
  return result.data as OperationsActor;
}
const params = (actor: OperationsUser) => ({ p_user_id: actor.userId, p_organization_id: actor.organizationId });
export async function getOperationsWorkspace(filters: Record<string, unknown> = {}): Promise<OperationsWorkspace> {
  return operationsWorkspaceFor(await requireOperationsActor(), filters);
}
export async function operationsWorkspaceFor(actor: OperationsUser, filters: Record<string, unknown> = {}): Promise<OperationsWorkspace> {
  const checkedFilters = { ...filters };
  for (const key of ['id', 'ownerId', 'caseId', 'fleetAssetId']) {
    if (checkedFilters[key] !== undefined) checkedFilters[key] = uuid(checkedFilters[key]);
  }
  if (checkedFilters.view !== undefined && !['open', 'done', 'all', 'returns', 'damage'].includes(String(checkedFilters.view))) {
    throw new TowingError('invalid_input', 400, 'Neplatné zobrazenie jázd.');
  }
  const result = await admin().rpc('motorist_operations_workspace', { ...params(actor), p_filters: checkedFilters });
  mapRpcError(result.error);
  return result.data as OperationsWorkspace;
}
export function parseOperationCommand(value: Record<string, unknown>, operationId?: string): OperationCommand {
  const actions = ['link_towing_return','create','assign','confirm','start','accept','arrive','collect','complete','cancel','reschedule','return','evidence','damage_update','inspect'];
  if (typeof value.action !== 'string' || !actions.includes(value.action) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))
    throw new TowingError('invalid_input', 400, 'Neplatný príkaz jazdy.');
  return { commandId: uuid(value.commandId), action: value.action as OperationCommand['action'], expectedRevision: revision(value.expectedRevision),
    ...(operationId || value.operationId ? { operationId: uuid(operationId ?? value.operationId) } : {}), payload: value.payload as Record<string, unknown> };
}
export async function commandOperation(command: OperationCommand): Promise<OperationReceipt> {
  return commandOperationFor(await requireOperationsActor(), command);
}
export type OperationLastPosition = { lat: number; lng: number; accuracy: number | null; recordedAt: string; member: string } | null;
/** Dispatch only (not a branch-scoped lead): where the executor last was during this operation. */
export async function getOperationLastPosition(operationId: string): Promise<{ position: OperationLastPosition }> {
  const actor = await requireOperationsActor();
  if (!actor.canDispatch) throw new TowingError('access_denied', 403, 'Polohu vykonávateľa vidí dispečer.');
  const result = await admin().rpc('motorist_operation_last_position', { ...params(actor), p_operation_id: uuid(operationId) });
  // A database before operation positions simply has none yet.
  if (result.error && ['PGRST202', '42883'].includes(result.error.code ?? '')) return { position: null };
  mapRpcError(result.error);
  const position = (result.data as { position?: unknown } | null)?.position ?? null;
  if (position === null) return { position: null };
  const value = position as Record<string, unknown>;
  if (typeof value.lat !== 'number' || typeof value.lng !== 'number' || typeof value.recordedAt !== 'string' || typeof value.member !== 'string') throw new TowingError('unavailable', 503, 'Polohu sa nepodarilo overiť.');
  return { position: { lat: value.lat, lng: value.lng, accuracy: typeof value.accuracy === 'number' ? value.accuracy : null, recordedAt: value.recordedAt, member: value.member } };
}
/** `refine` may turn a known refusal into a precise message before the generic mapping. */
export async function commandOperationFor(actor: OperationsUser, command: OperationCommand, refine?: (error: { code?: string; message?: string }) => void): Promise<OperationReceipt> {
  const result = await admin().rpc('motorist_operations_command', { ...params(actor), p_command: command });
  if (result.error) refine?.(result.error);
  mapRpcError(result.error);
  queueWorkPush(actor.organizationId);
  return result.data as OperationReceipt;
}
