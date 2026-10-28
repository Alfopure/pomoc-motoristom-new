import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { branchActions, branchViews, type BranchCommand, type BranchReceipt, type BranchReport, type BranchWorkspace } from '@/domain/work-groups';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { TowingError, mapRpcError, revision, uuid } from '@/server/towing/http';
import { queueWorkPush } from '@/server/mobile/push-outbox';
const admin = () => createSupabaseAdminClient() as unknown as SupabaseClient;
// Domain refusals the user can act on; everything else keeps the shared generic mapping.
const messages: [RegExp, number, string][] = [
  [/Already claimed/, 409, 'Požiadavku medzitým prevzal iný dispečer.'],
  [/Claim the request first/, 409, 'Najprv požiadavku prevezmite.'],
  [/Not your claim/, 403, 'Požiadavku prevzal iný dispečer.'],
  [/Assignee must belong to this group/, 400, 'Vykonávateľ musí patriť do tejto pobočky.'],
  [/Member unavailable/, 400, 'Vybraný vykonávateľ nemá aktívne oprávnenie na pristavovanie.'],
  [/Towing office permission required/, 403, 'Odťahovú zákazku zakladá iba účet s oprávnením odťahovej kancelárie.'],
  [/Group does not handle this service|Group unavailable/, 400, 'Vybraná pobočka tento druh práce neprijíma.'],
  [/Already in this group/, 400, 'Požiadavka už je v tejto pobočke.'],
  [/Only central routes unassigned work/, 403, 'Presúvať medzi pobočkami môže iba centrála a iba nepridelenú prácu.'],
  [/Confirmed cycle required/, 400, 'Odvoz potrebuje vybrané používanie vozidla (cyklus).'],
  [/Cancel the execution instead/, 409, 'Práca je už pridelená; zrušte konkrétnu jazdu.'],
  [/Capacity conflict/, 409, 'Vodič alebo vozidlo má v tomto čase inú potvrdenú jazdu.'],
  [/Interval required/, 400, 'Na potvrdenie termínu doplňte začiatok aj predpokladaný koniec.'],
  [/Work already started|Work started/, 409, 'Jazda už začala; termín ani vodiča nemožno zmeniť.'],
  [/Revision conflict/, 409, 'Údaje sa medzitým zmenili. Obnovte zoznam a skúste znova.'],
  [/Invalid group/, 400, 'Vyplňte názov pobočky a aspoň jeden druh práce.'],
  [/Invalid kind/, 400, 'Vyberte druh práce.'],
  [/Only cancelled executions reopen/, 409, 'Znovu otvoriť možno iba požiadavku so zrušenou jazdou.'],
  [/Towing access denied/, 403, 'Účet nemá aktívne oprávnenie odťahovej kancelárie.'],
  [/Assignment incomplete/, 400, 'Odťahová zákazka potrebuje pobočku, miesto nakládky a kontakt.'],
];
function mapBranchError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  const match = messages.find(([pattern]) => pattern.test(error.message ?? ''));
  if (match) throw new TowingError('branch_refused', match[1], match[2]);
  if (error.code === '42501') throw new TowingError('access_denied', 403, 'Nemáte prístup k modulu Pobočky.');
  mapRpcError(error);
}
async function currentUser() {
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new TowingError('unauthenticated', 401, 'Prihláste sa do aplikácie.');
  return { p_user_id: data.user.id, p_organization_id: await resolveDefaultOrganizationId() };
}
/** Who the branch RPCs re-authorize: a verified user of one organization (web session or mobile bearer). */
export type BranchUser = { p_user_id: string; p_organization_id: string };
export async function getBranchWorkspace(filters: Record<string, unknown> = {}): Promise<BranchWorkspace> {
  return branchWorkspaceFor(await currentUser(), filters);
}
export async function branchWorkspaceFor(user: BranchUser, filters: Record<string, unknown> = {}): Promise<BranchWorkspace> {
  const checked: Record<string, unknown> = {};
  for (const key of ['groupId', 'caseId', 'id']) if (filters[key] !== undefined && filters[key] !== '') checked[key] = uuid(filters[key]);
  if (filters.view !== undefined) { if (!branchViews.includes(filters.view as never)) throw new TowingError('invalid_input', 400, 'Neplatné zobrazenie.'); checked.view = filters.view; }
  for (const key of ['limit', 'offset']) if (filters[key] !== undefined) { const n = Number(filters[key]); if (!Number.isSafeInteger(n) || n < 0) throw new TowingError('invalid_input', 400, 'Neplatné stránkovanie.'); checked[key] = n; }
  const result = await admin().rpc('motorist_branch_workspace', { ...user, p_filters: checked });
  mapBranchError(result.error);
  return result.data as BranchWorkspace;
}
/** Page gate: 'signed-out', 'no-seat' or the actor (central profile or a lead seat). */
export async function getBranchAccess(): Promise<BranchWorkspace['actor'] | 'signed-out' | 'no-seat'> {
  let user;
  try { user = await currentUser(); } catch { return 'signed-out'; }
  const result = await admin().rpc('motorist_branch_actor', user);
  if (result.error?.code === '42501') return 'no-seat';
  mapBranchError(result.error);
  return result.data as BranchWorkspace['actor'];
}
export function parseBranchCommand(value: Record<string, unknown>): BranchCommand {
  if (typeof value.action !== 'string' || !branchActions.includes(value.action as never) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))
    throw new TowingError('invalid_input', 400, 'Neplatný príkaz pobočky.');
  return { commandId: uuid(value.commandId), action: value.action as BranchCommand['action'], payload: value.payload as Record<string, unknown>,
    ...(value.requestId !== undefined ? { requestId: uuid(value.requestId) } : {}), ...(value.expectedRevision !== undefined ? { expectedRevision: revision(value.expectedRevision) } : {}) };
}
export async function commandBranch(input: Record<string, unknown>): Promise<BranchReceipt> {
  const user = await currentUser();
  if (input.action === 'group_settings') return saveGroupSettings(user, input);
  return commandBranchFor(user, parseBranchCommand(input));
}
export async function commandBranchFor(user: BranchUser, command: BranchCommand): Promise<BranchReceipt> {
  const result = await admin().rpc('motorist_branch_command', { ...user, p_command: command });
  mapBranchError(result.error);
  queueWorkPush(user.p_organization_id);
  return result.data as BranchReceipt;
}
/** Escalation of waiting work: minutes before a reminder and whether central hears too. */
async function saveGroupSettings(user: Awaited<ReturnType<typeof currentUser>>, input: Record<string, unknown>): Promise<BranchReceipt> {
  const payload = (input.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>;
  const minutes = Number(payload.escalateAfterMinutes);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 1440 || typeof payload.escalateToCentral !== 'boolean') throw new TowingError('invalid_input', 400, 'Zadajte 5 až 1440 minút.');
  const result = await admin().rpc('motorist_branch_group_settings', { ...user, p_command_id: uuid(input.commandId), p_group_id: uuid(payload.groupId), p_expected_revision: revision(input.expectedRevision), p_escalate_after: minutes, p_escalate_to_central: payload.escalateToCentral });
  mapBranchError(result.error);
  return { commandId: uuid(input.commandId), ...(result.data as Pick<BranchReceipt, 'group'>) };
}
export async function getBranchReport(query: Record<string, string>): Promise<BranchReport> {
  const user = await currentUser();
  const from = new Date(query.from ?? ''); const to = new Date(query.to ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new TowingError('invalid_input', 400, 'Zadajte platné obdobie reportu.');
  const filters: Record<string, string> = {};
  if (query.groupId) filters.groupId = uuid(query.groupId);
  if (query.kind) { if (!['delivery', 'collection', 'transfer', 'tow'].includes(query.kind)) throw new TowingError('invalid_input', 400, 'Neplatný druh práce.'); filters.kind = query.kind; }
  const result = await admin().rpc('motorist_branch_report', { ...user, p_from: from.toISOString(), p_to: to.toISOString(), p_filters: filters });
  mapBranchError(result.error);
  return result.data as BranchReport;
}
