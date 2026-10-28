import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { branchActions, branchViews, type BranchCommand, type BranchReceipt, type BranchReport, type BranchWorkspace } from '@/domain/work-groups';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { TowingError, mapRpcError, revision, uuid } from '@/server/towing/http';
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
export async function getBranchWorkspace(filters: Record<string, unknown> = {}): Promise<BranchWorkspace> {
  const user = await currentUser();
  const checked: Record<string, unknown> = {};
  for (const key of ['groupId', 'caseId', 'id']) if (filters[key] !== undefined && filters[key] !== '') checked[key] = uuid(filters[key]);
  if (filters.view !== undefined) { if (!branchViews.includes(filters.view as never)) throw new TowingError('invalid_input', 400, 'Neplatné zobrazenie.'); checked.view = filters.view; }
  for (const key of ['limit', 'offset']) if (filters[key] !== undefined) { const n = Number(filters[key]); if (!Number.isSafeInteger(n) || n < 0) throw new TowingError('invalid_input', 400, 'Neplatné stránkovanie.'); checked[key] = n; }
  const result = await admin().rpc('motorist_branch_workspace', { ...user, p_filters: checked });
  mapBranchError(result.error);
  return result.data as BranchWorkspace;
}
/** Page gate: null when the signed-in account has neither a central profile nor a lead seat. */
export async function getBranchAccess(): Promise<BranchWorkspace['actor'] | null> {
  try { return (await getBranchWorkspace({ limit: 1 })).actor; }
  catch (error) { if (error instanceof TowingError && [401, 403].includes(error.status)) return null; throw error; }
}
export function parseBranchCommand(value: Record<string, unknown>): BranchCommand {
  if (typeof value.action !== 'string' || !branchActions.includes(value.action as never) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))
    throw new TowingError('invalid_input', 400, 'Neplatný príkaz pobočky.');
  return { commandId: uuid(value.commandId), action: value.action as BranchCommand['action'], payload: value.payload as Record<string, unknown>,
    ...(value.requestId !== undefined ? { requestId: uuid(value.requestId) } : {}), ...(value.expectedRevision !== undefined ? { expectedRevision: revision(value.expectedRevision) } : {}) };
}
export async function commandBranch(command: BranchCommand): Promise<BranchReceipt> {
  const result = await admin().rpc('motorist_branch_command', { ...await currentUser(), p_command: command });
  mapBranchError(result.error);
  return result.data as BranchReceipt;
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
