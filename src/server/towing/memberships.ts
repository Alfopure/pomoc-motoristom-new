import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
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
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(role => !['driver','dispatch','billing','manager','delivery'].includes(role))) throw new TowingError('invalid_input',400,'Vyberte oprávnenia účtu.');
  return [...new Set(value)] as TowingRole[];
}
function displayName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new TowingError('invalid_input',400,'Zadajte meno používateľa.'); return value.trim();
}
/** An Auth account can outlive a failed membership transaction. Its recovery is
 * bound to this exact server-authorized invite, never merely to an email match. */
async function provisionInviteAccount(admin: ReturnType<typeof towingAdmin>, actor: TowingMember, commandId: string,
  membershipId: string, recipient: string, name: string, assignedRoles: TowingRole[]) {
  // UUID identity is case-insensitive; keep the exact original envelope below
  // for provenance checks without deriving another account from its casing.
  const digest = createHash('sha256').update(JSON.stringify(['motorist-towing-invite-v1', actor.organizationId.toLowerCase(), actor.id.toLowerCase(), commandId.toLowerCase()])).digest();
  digest[6] = (digest[6] & 15) | 128; digest[8] = (digest[8] & 63) | 128;
  const hex = digest.toString('hex').slice(0,32);
  const userId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const provenance = { version: 1, organizationId: actor.organizationId, actorId: actor.id, commandId, membershipId,
    payloadHash: createHash('sha256').update(JSON.stringify({ membershipId, email: recipient, displayName: name, roles: assignedRoles })).digest('hex') };
  const unavailable = () => new TowingError('unavailable',503,'Prípravu účtu sa nepodarilo overiť. Zopakujte rovnaký pokus.');
  const conflict = () => new TowingError('account_unavailable',409,'Účet sa nepodarilo pripraviť. Správca musí overiť existujúci prístup.');
  const verify = (user: User) => {
    const metadata = user.app_metadata;
    const stored = metadata?.towing_invite;
    if (user.id !== userId || user.email?.toLowerCase() !== recipient || metadata?.motorist_module !== 'towing' || metadata?.towing_only !== true
      || !stored || typeof stored !== 'object' || Array.isArray(stored)
      || Object.entries(provenance).some(([key,value]) => stored[key] !== value)) throw conflict();
    return user.id;
  };
  const lookup = async () => {
    let result: Awaited<ReturnType<typeof admin.auth.admin.getUserById>>;
    try { result = await admin.auth.admin.getUserById(userId); } catch { throw unavailable(); }
    if (result.error) {
      if (result.error.status === 404 && !result.data.user) return null;
      throw unavailable();
    }
    if (!result.data.user) throw unavailable();
    return result.data.user;
  };
  const previous = await lookup();
  if (previous) return verify(previous);
  let created: Awaited<ReturnType<typeof admin.auth.admin.createUser>> | undefined;
  try {
    created = await admin.auth.admin.createUser({ id: userId, email: recipient, email_confirm: true,
      app_metadata: { motorist_module: 'towing', towing_only: true, towing_invite: provenance }, user_metadata: { display_name: name } });
  } catch { /* The provider may have committed before its response was lost. */ }
  if (!created?.error && created?.data.user) return verify(created.data.user);
  // A concurrent identical attempt or a lost provider ACK can only recover this
  // deterministic ID with the original service-owned provenance intact.
  const recovered = await lookup();
  if (recovered) return verify(recovered);
  if (created?.error?.status && created.error.status >= 400 && created.error.status < 500) throw conflict();
  throw unavailable();
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
      userId = await provisionInviteAccount(admin, actor, commandId, id, recipient, name, assignedRoles);
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
