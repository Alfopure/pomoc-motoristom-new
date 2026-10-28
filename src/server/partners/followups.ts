import 'server-only';
import type { MotoristActor } from '@/server/api-auth';
import { partnerPeriod, type PartnerActor, type PartnerFollowupOverview, type PartnerPortalData } from '@/domain/partners';
import { MutationError } from '@/server/mutation-error';
import { partnerAdmin, partnerCheck, uuid } from './client';
import { assertPartnerOffice } from './service';

export const PARTNER_FOLLOWUP_ACTIONS = ['take', 'contacted', 'note'] as const;
function revision(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MutationError('Neplatná revízia.', 400); return value as number; }
export function followupPeriod(from: string | null, to: string | null) { const period = partnerPeriod(from, to); if (!period) throw new MutationError('Zvoľte platné obdobie (najviac 400 dní).', 400); return period; }

/** Only these partner portal commands and fields reach SQL; the RPC re-checks membership and case ownership. */
export function parsePartnerFollowupCommand(input: unknown) {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const action = PARTNER_FOLLOWUP_ACTIONS.find(a => a === body.action);
  if (!action) throw new MutationError('Nepovolená operácia.', 400);
  const caseId = uuid(body.caseId); const commandId = uuid(body.commandId);
  if (action !== 'note') return { action, commandId, expectedRevision: revision(body.expectedRevision), payload: { caseId } };
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 2000) throw new MutationError('Poznámka musí mať 1 až 2000 znakov.', 400);
  return { action, commandId, expectedRevision: 0, payload: { caseId, body: text } };
}
export function parsePartnerInsuranceCommand(input: unknown) {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>; const payload = (body.payload && typeof body.payload === 'object' ? body.payload : {}) as Record<string, unknown>;
  if (typeof payload.insuranceEvent !== 'boolean') throw new MutationError('Zvoľte, či ide o poistnú udalosť.', 400);
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  if (label.length > 80) throw new MutationError('Označenie poistnej udalosti má najviac 80 znakov.', 400);
  return { commandId: uuid(body.commandId), expectedRevision: revision(body.expectedRevision), payload: { caseId: uuid(payload.caseId), insuranceEvent: payload.insuranceEvent, label: payload.insuranceEvent && label ? label : null } };
}

export async function readPartnerPortal(actor: PartnerActor, from: string | null, to: string | null): Promise<PartnerPortalData> {
  const period = followupPeriod(from, to);
  const result = await partnerAdmin().rpc('motorist_partner_portal_cases', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_membership_version: actor.version, p_from: period.from, p_to: period.to });
  partnerCheck(result.error); return result.data as PartnerPortalData;
}
export async function partnerFollowupCommand(actor: PartnerActor, input: unknown) {
  const command = parsePartnerFollowupCommand(input);
  const result = await partnerAdmin().rpc('motorist_partner_followup_command', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_membership_version: actor.version, p_command_id: command.commandId, p_expected_revision: command.expectedRevision, p_action: command.action, p_payload: command.payload });
  partnerCheck(result.error); return result.data;
}
/** Missing follow-up RPC (migration not yet applied) is the only error read as "unavailable" (null). */
export function isMissingFollowupRpc(error: { code?: string } | null) { return error?.code === 'PGRST202' || error?.code === '42883'; }
export async function readPartnerFollowupOffice(actor: MotoristActor, caseId: string | null, from: string | null = null, to: string | null = null): Promise<PartnerFollowupOverview | null> {
  await assertPartnerOffice(actor); const period = followupPeriod(from, to);
  const result = await partnerAdmin().rpc('motorist_partner_followup_office_read', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_from: period.from, p_to: period.to, p_case_id: caseId ? uuid(caseId) : null });
  if (isMissingFollowupRpc(result.error)) { console.warn('partner follow-up RPC is not installed; follow-up section hidden', result.error?.code); return null; }
  if (result.error) console.error('partner follow-up office read failed', result.error.code, result.error.message);
  partnerCheck(result.error); return result.data as PartnerFollowupOverview;
}
export async function setPartnerInsurance(actor: MotoristActor, input: unknown) {
  await assertPartnerOffice(actor); const command = parsePartnerInsuranceCommand(input);
  const result = await partnerAdmin().rpc('motorist_partner_followup_office_command', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_command_id: command.commandId, p_expected_revision: command.expectedRevision, p_action: 'set_insurance', p_payload: command.payload });
  partnerCheck(result.error); return result.data;
}
