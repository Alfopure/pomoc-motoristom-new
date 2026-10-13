import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import type { TowingMember, TowingRole } from '@/domain/towing/types';
import { buildAppUrl, escapeHtml, getEmailConfig, sendEmailWithOutcome } from '@/server/email-delivery';
import { assertRateLimit, requestIp } from '@/server/rate-limit';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { actorRpcParams, assertTowingEnabled } from './auth';
import { towingAdmin } from './client';
import { executeTowingCommand } from './service';
import { mapRpcError, revision, TowingError, uuid } from './http';

export function towingForgotResult() { return {ok:true,message:'Ak má účet aktívny prístup, pošleme odkaz na obnovu hesla.'}; }
function email(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value)) throw new TowingError('invalid_input',400,'Zadajte platný email.');
  return value.trim().toLowerCase();
}
function roles(value: unknown): TowingRole[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(role => !['driver','dispatch','billing','manager'].includes(role))) throw new TowingError('invalid_input',400,'Vyberte oprávnenia účtu.');
  return [...new Set(value)] as TowingRole[];
}
function displayName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new TowingError('invalid_input',400,'Zadajte meno používateľa.'); return value.trim();
}
async function sendAccessLink(recipient: string, name: string, key: string, authUserId: string) {
  const admin = towingAdmin();
  const next = '/auth/set-password?module=towing';
  const redirectTo = buildAppUrl(`/auth/callback?next=${encodeURIComponent(next)}`);
  const link = await admin.auth.admin.generateLink({type:'recovery',email:recipient,options:{redirectTo}});
  if (link.error || !link.data.properties?.action_link || link.data.user?.id !== authUserId) throw new TowingError('unavailable',503,'Odkaz na nastavenie hesla nie je dostupný.');
  const actionLink = link.data.properties.action_link;
  const outcome = await sendEmailWithOutcome({to:recipient,subject:'Prístup k zákazkám — Pomoc Motoristom',
    html:`<p>Dobrý deň ${escapeHtml(name)},</p><p><a href="${escapeHtml(actionLink)}">Nastaviť heslo k zákazkám</a></p>`,
    text:`Dobrý deň ${name},\nNastaviť heslo k zákazkám: ${actionLink}`,idempotencyKey:key});
  return {status:outcome.status === 'sent' ? 'accepted' : outcome.status,providerMessageId:outcome.status === 'sent' ? outcome.messageId : null};
}
async function claimAccessEmail(actor: TowingMember | null, organizationId: string, memberId: string, id: string, purpose: 'invite' | 'reset' | 'forgot') {
  const admin = towingAdmin();
  const claim = await admin.rpc('motorist_towing_access_email_claim', {
    ...(actor ? actorRpcParams(actor) : {p_user_id:null,p_organization_id:organizationId,p_membership_version:null}),
    p_id:id,p_member_id:memberId,p_purpose:purpose,
  });
  mapRpcError(claim.error);
  const data = claim.data as {shouldSend:boolean;id:string;recipient:string;displayName:string;userId:string;status:string} | null;
  if (!data) throw new TowingError('unavailable',503,'Odoslanie odkazu nie je dostupné.');
  if (!data.shouldSend) return {status:data.status,providerMessageId:null};
  let outcome: {status:string;providerMessageId:string|null};
  try { outcome = getEmailConfig().enabled ? await sendAccessLink(data.recipient,data.displayName,`towing-access-${id}`,data.userId) : {status:'disabled',providerMessageId:null}; }
  catch { outcome = {status:'failed',providerMessageId:null}; }
  const result = await admin.rpc('motorist_towing_access_email_result',{p_id:id,p_status:outcome.status === 'disabled' ? 'failed' : outcome.status,p_provider_message_id:outcome.providerMessageId});
  mapRpcError(result.error);
  return outcome;
}
export async function manageTowingMembership(actor: TowingMember, input: Record<string,unknown>) {
  if (!actor.capabilities.includes('members')) throw new TowingError('access_denied',403,'Nemáte oprávnenie spravovať prístupy.');
  const id = uuid(input.membershipId); const admin = towingAdmin();
  if (input.action === 'reset') {
    const result = await admin.from('motorist_towing_memberships').select('id,email,display_name,auth_user_id').eq('id',id).eq('organization_id',actor.organizationId).eq('active',true).maybeSingle();
    mapRpcError(result.error);
    if (!result.data?.email) throw new TowingError('not_found',404,'Účet nie je dostupný.');
    assertRateLimit(`towing-reset:${actor.id}:${id}`,{limit:3,windowMs:3600000});
    return {ok:true,delivery:await claimAccessEmail(actor,actor.organizationId,id,uuid(input.commandId),'reset')};
  }
  if (input.action !== 'invite' && input.action !== 'update') throw new TowingError('invalid_input',400,'Nepovolená operácia prístupu.');
  const commandId = uuid(input.commandId);
  let emailInput = input.email;
  if (input.action === 'update' && (emailInput === undefined || emailInput === '')) {
    const existing = await admin.from('motorist_towing_memberships').select('email').eq('id',id).eq('organization_id',actor.organizationId).maybeSingle();
    mapRpcError(existing.error); emailInput = existing.data?.email;
  }
  const recipient = email(emailInput); const name = displayName(input.displayName); const assignedRoles = roles(input.roles);
  let userId: string;
  if (input.action === 'update') userId = uuid(input.userId);
  else {
    assertRateLimit(`towing-invite:${actor.id}`,{limit:20,windowMs:3600000});
    const previous = await admin.from('motorist_towing_memberships').select('auth_user_id').eq('id',id).eq('organization_id',actor.organizationId).maybeSingle(); mapRpcError(previous.error);
    const office = await admin.from('motorist_profiles').select('user_id').eq('organization_id',actor.organizationId).eq('email',recipient).eq('active',true).maybeSingle(); mapRpcError(office.error);
    if (previous.data?.auth_user_id) userId = previous.data.auth_user_id;
    else if (office.data?.user_id) userId = office.data.user_id;
    else {
      const created = await admin.auth.admin.createUser({email:recipient,email_confirm:true,app_metadata:{motorist_module:'towing',towing_only:true},user_metadata:{display_name:name}});
      if (created.error || !created.data.user) throw new TowingError('account_unavailable',409,'Účet sa nepodarilo pripraviť. Správca musí overiť existujúci prístup.');
      userId = created.data.user.id;
    }
  }
  const result = await executeTowingCommand(actor,{commandId,type:'set_member',targetId:id,payload:{userId,email:recipient,displayName:name,roles:assignedRoles,
    active:input.action === 'invite' ? true : input.active === true,...(input.action === 'update' ? {expectedVersion:revision(input.expectedVersion)} : {})}});
  if (input.action === 'update') return result;
  // Explicit invite request only; no automatic mail on ordinary profile or order changes.
  return {...result,delivery:await claimAccessEmail(actor,actor.organizationId,id,commandId,'invite')};
}
export async function sendTowingForgotPassword(input: unknown, request: Request) {
  assertTowingEnabled(); const recipient = email(input);
  const key = createHash('sha256').update(`${requestIp(request)}:${recipient}`).digest('hex');
  assertRateLimit(`towing-forgot:${key}`,{limit:5,windowMs:3600000});
  if (!getEmailConfig().enabled) return towingForgotResult();
  const admin = towingAdmin(); const organizationId = await resolveDefaultOrganizationId();
  const result = await admin.from('motorist_towing_memberships').select('id,email,display_name').eq('organization_id',organizationId).eq('email',recipient).eq('active',true).maybeSingle();
  mapRpcError(result.error);
  if (result.data) await claimAccessEmail(null,organizationId,result.data.id,randomUUID(),'forgot');
  return towingForgotResult();
}
